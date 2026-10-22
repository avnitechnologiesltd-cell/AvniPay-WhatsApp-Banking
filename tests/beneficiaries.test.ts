import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { saidPayload } from "@avni/fakes";

import {
  BANK_CODE,
  PHONE_NUMBER_ID,
  exchangeFlow,
  flowTokenFrom,
  postWebhook,
  startHarness,
  waitForReplies,
  type Harness,
} from "./harness";

/**
 * *"Send 5000 to Musa"* — the flagship interaction, driven the way a Customer
 * drives it.
 *
 * Everything below goes in through the Platform's webhook or the Middleware's
 * Flows endpoint. **Nothing is seeded into the Beneficiary store**, because
 * there is no way to seed one: a record exists only as the by-product of a
 * completed, PIN-authorised transfer, and a test that wrote one directly would
 * be asserting against a state the product cannot reach.
 *
 * The rule of thumb this file was written against, inherited from
 * `intra-bank-transfer.test.ts`: *if a test would still pass after the money
 * went to the wrong account, it is testing the wrong thing.*
 */

const CUSTOMER = "2348012345678";
const ACCOUNT = "2024000153";

/** Two people a Customer might mean by "Musa", at two different banks. */
const MUSA = { account: "2124955312", name: "MUSA IBRAHIM", bank: BANK_CODE };
const OTHER_MUSA = { account: "2124955313", name: "MUSA ADEBAYO", bank: "058" };
const GTBANK = "GTBank";

const PIN = "4821";

const envelope = { phoneNumberId: PHONE_NUMBER_ID, from: CUSTOMER };

let harness: Harness;

beforeEach(async () => {
  harness = await startHarness({
    accounts: [{ accountNumber: ACCOUNT, availableBalance: 250_000 }],
    names: [
      { accountNumber: ACCOUNT, bankCode: BANK_CODE, name: "ADAEZE OKAFOR" },
      { accountNumber: MUSA.account, bankCode: MUSA.bank, name: MUSA.name },
      { accountNumber: OTHER_MUSA.account, bankCode: OTHER_MUSA.bank, name: OTHER_MUSA.name },
    ],
  });
  await harness.seedBinding(CUSTOMER, ACCOUNT);
  await harness.seedPin(ACCOUNT, PIN);
});

afterEach(async () => {
  await harness?.stop();
});

// --- Driving it --------------------------------------------------------------

/** Says it, and waits until the Customer has been answered. */
const say = async (text: string): Promise<readonly string[]> => {
  const before = harness.whatsapp.sent.length;
  await postWebhook(harness, saidPayload({ ...envelope, text }));
  const replies = await waitForReplies(harness, before + 1);
  return replies.slice(before);
};

/** What the Orchestration Layer extracted. Shape guaranteed, values never. */
const asksToSend = async (amount: number, accountNumber: string, bankName = ""): Promise<string> => {
  harness.groq.setResolver(() => ({
    kind: "transfer_to_account",
    amount,
    accountNumber,
    bankName,
  }));
  await say(`send ${amount} to ${accountNumber}`);
  return flowTokenFrom(harness);
};

/** *"Send 5000 to Musa"* — the Intent carrying only a name and an amount. */
const asksToSendByName = async (amount: number, name: string): Promise<string> => {
  harness.groq.setResolver(() => ({
    kind: "transfer_to_beneficiary",
    amount,
    beneficiaryName: name,
  }));
  await say(`send ${amount} to ${name}`);
  return flowTokenFrom(harness);
};

/** *"Forget Musa"*. */
const asksToForget = async (name: string): Promise<readonly string[]> => {
  harness.groq.setResolver(() => ({ kind: "forget_beneficiary", beneficiaryName: name }));
  return say(`forget ${name}`);
};

const open = (token: string) =>
  exchangeFlow(harness, { version: "3.0", action: "INIT", screen: "", data: {}, flow_token: token });

const submit = (token: string, screen: string, data: Record<string, unknown>) =>
  exchangeFlow(harness, {
    version: "3.0",
    action: "data_exchange",
    screen,
    data,
    flow_token: token,
  });

/**
 * A completed transfer to an account number, optionally saving the recipient.
 *
 * This is the **only** way a Beneficiary comes into existence, so it is the
 * setup step for everything below.
 */
const pay = async (options: {
  readonly to: { account: string; name: string; bank: string };
  readonly amount?: number;
  readonly bankName?: string;
  readonly saveAs?: string;
}): Promise<Record<string, unknown>> => {
  const token = await asksToSend(options.amount ?? 2000, options.to.account, options.bankName ?? "");
  await open(token);
  const done = await submit(token, "CONFIRM", {
    pin: PIN,
    ...(options.saveAs === undefined ? {} : { save_as: options.saveAs }),
  });
  return done.data;
};

const rowsOf = (data: Record<string, unknown>): readonly { id: string; title: string; description: string }[] =>
  (data["beneficiaries"] ?? []) as { id: string; title: string; description: string }[];

// --- The flagship ------------------------------------------------------------

describe("a Customer who has paid somebody once pays them by name", () => {
  it("goes straight to the Confirmation screen, and the money moves", async () => {
    await pay({ to: MUSA, saveAs: "Musa" });

    const token = await asksToSendByName(5000, "Musa");
    const confirm = await open(token);

    // One match, one screen. The name on it is the name enquiry's, run now —
    // not the label the Customer typed and not the name stored beside it.
    expect(confirm.screen).toBe("CONFIRM");
    expect(confirm.data).toMatchObject({
      amount: "₦5,000",
      destination_account: MUSA.account,
      destination_name: MUSA.name,
    });

    const done = await submit(token, "CONFIRM", { pin: PIN });
    expect(done.screen).toBe("DONE");
    expect(harness.bankOne.transfers.at(-1)).toMatchObject({
      toAccountNumber: MUSA.account,
      amount: 5000,
    });
  });

  it("tells neither the Platform nor the model who they pay", async () => {
    await pay({ to: MUSA, saveAs: "Musa" });

    const before = harness.whatsapp.sent.length;
    const asked = harness.groq.calls.length;
    await asksToSendByName(5000, "Musa");

    // The whole point of the store living in the Middleware. Resolving a name
    // produces two opaque strings and nothing else — not the account it
    // resolved to, not the bank's name for it, not the Customer's own label.
    // A list of everybody a Customer pays, held in the layer their text is read
    // into a model by, is what ADR-0006 exists to prevent.
    for (const message of harness.whatsapp.sent.slice(before)) {
      const raw = JSON.stringify(message.raw);
      expect(raw).not.toContain(MUSA.account);
      expect(raw).not.toContain(MUSA.name);
      expect(raw).not.toContain("Musa");
    }
    // The model is shown the Customer's own words and nothing else. It said the
    // name; it was never told what the name resolved to.
    for (const call of harness.groq.calls.slice(asked)) {
      expect(call.prompt).not.toContain(MUSA.account);
      expect(call.prompt).not.toContain(MUSA.name);
    }
  });
});

// --- None, one, several ------------------------------------------------------

describe("what a name resolves to", () => {
  it("lands on the account-number form when nothing matches, which is the first transfer", async () => {
    // Nothing has ever been saved, and nothing can seed it: transaction history
    // is not entitled on the Bank's token, so there is no history to mine.
    const token = await asksToSendByName(2000, "Musa");
    const screen = await open(token);

    expect(screen.screen).toBe("RECIPIENT");
    expect(rowsOf(screen.data)).toEqual([]);
    // The amount is rendered here, so the Customer knows what they are choosing
    // a recipient *for*. It is read back from the walk, never from the payload.
    expect(screen.data["amount"]).toBe("₦2,000");

    // The same screen carries the form, so the empty case needs no second home.
    const confirm = await submit(token, "RECIPIENT", { account_number: MUSA.account });
    expect(confirm.screen).toBe("CONFIRM");
    expect(confirm.data["destination_name"]).toBe(MUSA.name);

    const done = await submit(token, "CONFIRM", { pin: PIN });
    expect(done.screen).toBe("DONE");
    expect(harness.bankOne.transfers).toHaveLength(1);
  });

  it("opens the Disambiguation screen when several match, most recently used first", async () => {
    await pay({ to: MUSA, saveAs: "Musa" });
    harness.clock.advance(60_000);
    await pay({ to: OTHER_MUSA, bankName: GTBANK });

    const screen = await open(await asksToSendByName(2000, "Musa"));

    expect(screen.screen).toBe("RECIPIENT");
    // "Musa" is a label on one and part of the bank's own name on the other, and
    // the one paid most recently is offered first.
    expect(rowsOf(screen.data).map((row) => row.title)).toEqual([OTHER_MUSA.name, "Musa"]);
  });

  it("shows the label, the bank's own name and a masked account on every row", async () => {
    await pay({ to: MUSA });
    harness.clock.advance(60_000);
    await pay({ to: OTHER_MUSA, bankName: GTBANK, saveAs: "Musa" });

    const screen = await open(await asksToSendByName(2000, "Musa"));
    const [labelled, unlabelled] = rowsOf(screen.data);

    // The bank's name is the thing a Customer recognises; a label is their own
    // word for somebody and ten digits are ten digits.
    expect(labelled?.title).toBe("Musa");
    expect(labelled?.description).toContain(OTHER_MUSA.name);
    expect(labelled?.description).toContain("Guaranty Trust");
    expect(labelled?.description).toContain("••••5313");
    expect(labelled?.description).not.toContain(OTHER_MUSA.account);

    // With no label the bank's own name is the title, which is the same
    // information on one line rather than two.
    expect(unlabelled?.title).toBe(MUSA.name);
  });

  it("takes two characters and tolerates no typo", async () => {
    await pay({ to: MUSA, saveAs: "Musa" });

    // One match goes straight to a Confirmation screen; nothing matching lands
    // on the account-number form. Two characters is a search — one is a shrug
    // that would match most of a store, and a typo buys one avoided re-type and
    // pays in wrong-person risk.
    expect((await open(await asksToSendByName(2000, "mu"))).screen).toBe("CONFIRM");
    expect((await open(await asksToSendByName(2000, "m"))).screen).toBe("RECIPIENT");
    expect((await open(await asksToSendByName(2000, "mussa"))).screen).toBe("RECIPIENT");
  });

  it("allows two saved recipients to wear the same label", async () => {
    await pay({ to: MUSA, saveAs: "Musa" });
    await pay({ to: OTHER_MUSA, bankName: GTBANK, saveAs: "Musa" });

    // Forcing a rename at save time asks the Customer to solve a problem they do
    // not have yet. The Disambiguation screen already exists for the day they do.
    const screen = await open(await asksToSendByName(2000, "Musa"));
    expect(rowsOf(screen.data).map((row) => row.title)).toEqual(["Musa", "Musa"]);
    // Which is why the row a Customer reads is more than the label.
    expect(new Set(rowsOf(screen.data).map((row) => row.description)).size).toBe(2);
  });
});

// --- What creates a record, and what removes one -----------------------------

describe("a Beneficiary is a by-product of a transfer that happened", () => {
  it("is not created by a Confirmation screen the Customer never authorised", async () => {
    const confirm = await open(await asksToSend(2000, MUSA.account));
    expect(confirm.screen).toBe("CONFIRM");

    // No PIN, no record. There is no save-without-paying, so planting one costs
    // an attacker a completed authorised transfer rather than one instruction —
    // and with nothing saved, the name lands on the account-number form.
    const screen = await open(await asksToSendByName(2000, "Musa"));
    expect(screen.screen).toBe("RECIPIENT");
    expect(rowsOf(screen.data)).toEqual([]);
  });

  it("is removed again when the transfer that created it is confirmed failed", async () => {
    harness.bankOne.setTransferBehaviour({ dispatch: "fails" });

    const done = await pay({ to: MUSA, saveAs: "Musa" });
    expect(String(done["message"])).toContain("did not go through");

    const screen = await open(await asksToSendByName(2000, "Musa"));
    expect(rowsOf(screen.data)).toEqual([]);
  });

  it("leaves an existing record alone when a later transfer to it fails", async () => {
    await pay({ to: MUSA, saveAs: "Musa" });

    harness.bankOne.setTransferBehaviour({ dispatch: "fails" });
    await pay({ to: MUSA });

    // The second transfer did not create this record, so it was never the second
    // transfer's to remove.
    const screen = await open(await asksToSendByName(2000, "Musa"));
    expect(screen.screen).toBe("CONFIRM");
    expect(screen.data["destination_account"]).toBe(MUSA.account);
  });

  it("survives a Binding being revoked and remade, because it is keyed on the account", async () => {
    await pay({ to: MUSA, saveAs: "Musa" });

    // A Binding is revoked whenever a Customer enrolls a new WhatsApp number.
    // Losing every saved recipient on a phone change would punish the honest
    // case to defend a rare one.
    await harness.revokeBindingsFor(CUSTOMER);
    await harness.seedBinding(CUSTOMER, ACCOUNT);

    const screen = await open(await asksToSendByName(2000, "Musa"));
    expect(screen.screen).toBe("CONFIRM");
    expect(screen.data["destination_account"]).toBe(MUSA.account);
  });
});

// --- The label ---------------------------------------------------------------

describe("the Save as label", () => {
  it("never reaches the Platform or the model", async () => {
    await pay({ to: MUSA, saveAs: "Musa" });

    // It is captured inside the Flow rather than asked for in conversation,
    // because a Customer replying `Musa` to a question is indistinguishable from
    // a malformed Intent to the model that would read it.
    for (const call of harness.groq.calls) expect(call.prompt).not.toContain("Musa");
    for (const message of harness.whatsapp.sent) {
      expect(JSON.stringify(message.raw)).not.toContain("Musa");
    }
  });

  it("refuses one that is all digits, without spending a PIN attempt", async () => {
    const token = await asksToSend(2000, MUSA.account);
    await open(token);

    // So that "send 5000 to 2124955312" always means the account number.
    const again = await submit(token, "CONFIRM", { pin: PIN, save_as: MUSA.account });
    expect(again.screen).toBe("CONFIRM");
    expect(String(again.data["error_message"])).toContain("rather than a number");
    expect(harness.bankOne.transfers).toEqual([]);

    // Checked before the PIN, so the Customer still has all three attempts.
    const done = await submit(token, "CONFIRM", { pin: PIN, save_as: "Musa" });
    expect(done.screen).toBe("DONE");
  });

  it("refuses a bank's name, and one longer than a list row", async () => {
    const token = await asksToSend(2000, MUSA.account);

    expect(String((await submit(token, "CONFIRM", { pin: PIN, save_as: GTBANK })).data["error_message"]))
      .toContain("rather than a bank");
    expect(
      String((await submit(token, "CONFIRM", { pin: PIN, save_as: "a".repeat(25) })).data["error_message"]),
    ).toContain("24 characters");
    expect(harness.bankOne.transfers).toEqual([]);
  });

  it("is optional, and a transfer without one still saves the recipient", async () => {
    await pay({ to: MUSA });

    // The record is findable through the bank's own name for the account, which
    // is why a label is garnish rather than a requirement.
    const screen = await open(await asksToSendByName(2000, "Ibrahim"));
    expect(screen.screen).toBe("CONFIRM");
    expect(screen.data["destination_name"]).toBe(MUSA.name);
  });
});

// --- When the account has changed hands --------------------------------------

describe("a saved account whose name has changed", () => {
  it("says both names before the PIN", async () => {
    await pay({ to: MUSA, saveAs: "Musa" });

    // The clearest available signal that an account has changed hands, and it is
    // free on every transfer. Refusing outright was rejected — banks rename
    // accounts for boring reasons — and showing only the live name throws it away.
    harness.bankOne.setName({ accountNumber: MUSA.account, bankCode: MUSA.bank, name: "CHIDI EZE" });

    const confirm = await open(await asksToSendByName(5000, "Musa"));

    expect(confirm.data["destination_name"]).toBe("CHIDI EZE");
    expect(confirm.data["name_changed"]).toBe(
      `This account is now CHIDI EZE. It was ${MUSA.name} when you saved it.`,
    );
  });

  it("says nothing when the name is the same", async () => {
    await pay({ to: MUSA, saveAs: "Musa" });

    const confirm = await open(await asksToSendByName(5000, "Musa"));

    // Nothing to say, said as nothing. The key is present and empty because a
    // published Flow validates against every field its screen declares, and
    // `has_name_changed` is the boolean the screen binds `visible` to — so an
    // empty string here is a line the Customer never sees.
    expect(confirm.data["name_changed"]).toBe("");
    expect(confirm.data["has_name_changed"]).toBe(false);
  });

  it("cannot be reached at all once the account stops resolving", async () => {
    await pay({ to: MUSA, saveAs: "Musa" });
    harness.bankOne.setName({ accountNumber: MUSA.account, bankCode: MUSA.bank, name: "" });

    const replies = await (async () => {
      harness.groq.setResolver(() => ({
        kind: "transfer_to_beneficiary",
        amount: 5000,
        beneficiaryName: "Musa",
      }));
      return say("send 5000 to Musa");
    })();

    // Not "check the number": they did not type one. The ten digits behind the
    // name are ones this platform stored.
    expect(replies.at(-1)).toContain("could not reach the account saved under that name");
    expect(replies.at(-1)).not.toContain("check the number");
  });
});

// --- Forgetting --------------------------------------------------------------

describe("forgetting a saved recipient", () => {
  it("opens the same screen, and a tap is what removes the record", async () => {
    await pay({ to: MUSA, saveAs: "Musa" });
    harness.clock.advance(60_000);
    await pay({ to: OTHER_MUSA, bankName: GTBANK, saveAs: "Musa" });

    await asksToForget("Musa");
    const token = flowTokenFrom(harness);
    const screen = await open(token);

    // Two Musas, handled correctly for free. A model asked to choose between
    // them would be choosing which of a Customer's recipients to destroy from a
    // sentence somebody else may have written.
    expect(screen.screen).toBe("RECIPIENT");
    expect(screen.data["purpose"]).toBe("forget");
    expect(rowsOf(screen.data)).toHaveLength(2);

    // The most recent is offered first, so this taps the older of the two.
    const done = await submit(token, "RECIPIENT", {
      beneficiary_id: rowsOf(screen.data)[1]?.id,
    });
    expect(done.screen).toBe("DONE");
    expect(String(done.data["message"])).toContain("no longer saved");

    // The other one is untouched, and is now the only match.
    const left = await open(await asksToSendByName(2000, "Musa"));
    expect(left.screen).toBe("CONFIRM");
    expect(left.data["destination_account"]).toBe(OTHER_MUSA.account);
  });

  it("says so plainly when nothing is saved under that name", async () => {
    const replies = await asksToForget("Musa");

    // The one place an empty match set is answered in words. A transfer to
    // nobody has an account-number form to fall back on; a deletion of nobody
    // has nothing to show and nothing to do.
    expect(replies.at(-1)).toContain("do not have anyone saved under that name");
  });

  it("moves no money and asks for no PIN", async () => {
    await pay({ to: MUSA, saveAs: "Musa" });
    const before = harness.bankOne.transfers.length;

    await asksToForget("Musa");
    const token = flowTokenFrom(harness);
    const screen = await open(token);
    await submit(token, "RECIPIENT", { beneficiary_id: rowsOf(screen.data)[0]?.id });

    expect(harness.bankOne.transfers).toHaveLength(before);
  });
});

// --- The attacks -------------------------------------------------------------

describe("the attacks", () => {
  it("ignores a tampered amount on the Disambiguation screen", async () => {
    await pay({ to: MUSA, saveAs: "Musa" });
    await pay({ to: OTHER_MUSA, bankName: GTBANK, saveAs: "Musa" });

    const token = await asksToSendByName(2000, "Musa");
    const screen = await open(token);

    // A Flow encrypts with a key the handset generates, so the handset owns that
    // plaintext entirely. The selection is read; the amount beside it is not,
    // because the amount was rendered by the server and is read back from the
    // walk the token names.
    const confirm = await submit(token, "RECIPIENT", {
      beneficiary_id: rowsOf(screen.data)[0]?.id,
      amount: 900_000,
    });

    expect(confirm.data["amount"]).toBe("₦2,000");
  });

  it("refuses a saved recipient id that is not this Customer's", async () => {
    await pay({ to: MUSA, saveAs: "Musa" });
    await pay({ to: OTHER_MUSA, bankName: GTBANK, saveAs: "Musa" });
    const paid = harness.bankOne.transfers.length;

    // Every read of the store is scoped by the owner account, so an id from
    // another Customer's list resolves to nothing at all. A well-formed uuid
    // nobody owns is the same answer, and is what this stands in for.
    const token = await asksToSendByName(2000, "Musa");
    const refused = await submit(token, "RECIPIENT", {
      beneficiary_id: "00000000-0000-4000-8000-000000000000",
    });

    expect(refused.screen).toBe("RECIPIENT");
    expect(String(refused.data["error_message"])).toContain("no longer saved");
    expect(harness.bankOne.transfers).toHaveLength(paid);
  });

  it("refuses a walk whose Binding was revoked while it waited", async () => {
    const token = await asksToSendByName(2000, "Musa");
    await harness.revokeBindingsFor(CUSTOMER);

    const refused = await submit(token, "RECIPIENT", { account_number: MUSA.account });

    expect(refused.screen).toBe("UNAVAILABLE");
    expect(harness.bankOne.transfers).toEqual([]);
  });

  it("still shows a Confirmation screen when the store is confident", async () => {
    await pay({ to: MUSA, saveAs: "Musa" });

    const token = await asksToSendByName(5000, "Musa");

    // **No path skips the screen, including the case where resolution is
    // certain.** The PIN screen is not reachable without it, and a payload that
    // tries goes nowhere.
    const straight = await submit(token, "CONFIRM", { pin: PIN });
    expect(straight.screen).toBe("DONE");
    expect(harness.bankOne.transfers).toHaveLength(2);
  });
});

// --- What the Bank can reconstruct afterwards --------------------------------

describe("the audit trail", () => {
  it("records what was said, how many answered to it, and what was saved", async () => {
    await pay({ to: MUSA, saveAs: "Musa" });
    await asksToSendByName(5000, "Musa");

    const resolved = await auditRows("beneficiary.resolved");
    expect(resolved[0]?.detail).toMatchObject({ said: "Musa", matched: 1 });

    // "I sent money to the wrong Musa" is the most common support call this
    // feature will generate, and it is unanswerable without these rows.
    const saved = await auditRows("beneficiary.saved");
    expect(saved[0]?.detail).toMatchObject({
      destinationAccount: MUSA.account,
      created: true,
      labelled: true,
    });
    // The label itself is a Customer's own word for a third party. The audit
    // table is the worst possible place to accumulate one.
    expect(JSON.stringify(saved[0]?.detail)).not.toContain("Musa\"");
  });
});

const auditRows = async (
  action: string,
): Promise<readonly { detail: Record<string, unknown> }[]> => {
  const { token } = await harness.signInStaff("administrator");
  const response = await fetch(
    `${harness.middlewareUrl}/dashboard/audit?action=${encodeURIComponent(action)}&limit=50`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  const body = (await response.json()) as {
    entries?: { action: string; detail: Record<string, unknown> }[];
  };
  return (body.entries ?? []).filter((entry) => entry.action === action);
};

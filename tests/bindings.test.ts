import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DAY, chosePayload, deliveryReceiptPayload, saidPayload } from "@avni/fakes";

import {
  exchangeFlow,
  flowTokenFrom,
  postWebhook,
  startHarness,
  waitForReplies,
  type Harness,
} from "./harness";

/**
 * What enrollment leaves behind, and everything that happens to it afterwards.
 *
 * The Binding is the record that says a WhatsApp number reaches one bank
 * account. Its whole lifecycle is a security event, and three of the rules below
 * exist because of one scenario: a handset changes hands. Either a phone is
 * stolen and the Customer needs the old Binding dead in minutes, or a dormant
 * number is recycled by the operator and a stranger inherits it.
 */

const CHIDI = "2348012345678";
const CHIDIS_NEW_PHONE = "2348055555555";
const ACCOUNT = "2024000153";
const OTHER_ACCOUNT = "2024000263";
const CODE = "482913";
const PIN = "4821";

const envelope = { phoneNumberId: "test-phone-number-id", from: CHIDI };

let harness: Harness;

beforeEach(async () => {
  harness = await startHarness({
    accounts: [
      { accountNumber: ACCOUNT, availableBalance: 250_000 },
      { accountNumber: OTHER_ACCOUNT, availableBalance: 10_000 },
    ],
    identityAccounts: [
      {
        accountNumber: ACCOUNT,
        code: CODE,
        destinations: [{ id: "d1", kind: "phone", masked: "••• ••• 6655" }],
      },
      {
        accountNumber: OTHER_ACCOUNT,
        code: CODE,
        destinations: [{ id: "d1", kind: "phone", masked: "••• ••• 1122" }],
      },
    ],
  });
});

afterEach(async () => {
  await harness?.stop();
});

// --- Driving it --------------------------------------------------------------

const say = async (from: string, text: string): Promise<readonly string[]> => {
  const before = harness.whatsapp.sent.length;
  await postWebhook(harness, saidPayload({ phoneNumberId: "test-phone-number-id", from, text }));
  return waitForReplies(harness, before + 1);
};

const tap = async (from: string, id: string): Promise<readonly string[]> => {
  const before = harness.whatsapp.sent.length;
  await postWebhook(harness, chosePayload({ phoneNumberId: "test-phone-number-id", from, id }));
  return waitForReplies(harness, before + 1);
};

const submit = (token: string, screen: string, data: Record<string, unknown>) =>
  exchangeFlow(harness, { version: "3.0", action: "data_exchange", screen, data, flow_token: token });

const init = (token: string) =>
  exchangeFlow(harness, { version: "3.0", action: "INIT", screen: "", data: {}, flow_token: token });

/** The whole front door, for a test that is about what happens next. */
const enroll = async (from: string, accountNumber = ACCOUNT, pin = PIN): Promise<void> => {
  await say(from, "hello");
  await tap(from, "enroll_link");
  const token = flowTokenFrom(harness);

  await submit(token, "IDENTIFY", { account_number: accountNumber });
  await submit(token, "CHOOSE_DESTINATION", { destination_id: "d1" });
  await submit(token, "CODE", { code: CODE });
  const done = await submit(token, "SET_PIN", { pin, pin_confirmation: pin });
  if (done.screen !== "DONE") throw new Error(`Enrollment ended on ${done.screen}`);
};

const isLinked = async (from: string): Promise<boolean> => {
  const replies = await say(from, "what's my balance");
  return !(replies.at(-1) ?? "").includes("Do you have a bank account");
};

const auditRows = async (): Promise<{ action: string; detail: Record<string, unknown> }[]> => {
  const { token } = await harness.signInStaff("administrator");
  const response = await fetch(`${harness.middlewareUrl}/dashboard/audit?limit=500`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = (await response.json()) as {
    entries: { action: string; detail: Record<string, unknown> }[];
  };
  return body.entries;
};

// --- One account, one number -------------------------------------------------

describe("enrolling the same account on a new number", () => {
  it("kills the old Binding in minutes rather than in ninety days", async () => {
    await enroll(CHIDI);
    expect(await isLinked(CHIDI)).toBe(true);

    // The phone was stolen an hour ago. Chidi links the replacement himself,
    // without waiting for a Support Officer to be at their desk on Monday.
    await enroll(CHIDIS_NEW_PHONE);

    expect(await isLinked(CHIDIS_NEW_PHONE)).toBe(true);
    expect(await isLinked(CHIDI)).toBe(false);
  });

  it("tells the revoked number, and the contact on record", async () => {
    await enroll(CHIDI);
    const before = harness.whatsapp.sent.length;

    await enroll(CHIDIS_NEW_PHONE);

    // The mitigation for auto-revoke's one real cost: a SIM-swap attacker who
    // can receive the code enrols on their own number and locks the Customer
    // out. Telling both turns a silent takeover into one that can be reported.
    const toldTheOldNumber = harness.whatsapp.sent
      .slice(before)
      .filter((message) => message.to === CHIDI);
    expect(toldTheOldNumber.map((message) => message.text).join(" ")).toContain(
      "switched off",
    );

    expect(harness.bankIdentity.noticesSent).toEqual([
      { accountNumber: ACCOUNT, event: "binding_revoked_by_new_enrollment" },
    ]);
  });

  it("never puts the account number in the message to the revoked number", async () => {
    // That handset may be in somebody else's hands. That is why it is being told.
    await enroll(CHIDI);
    await enroll(CHIDIS_NEW_PHONE);

    const toChidi = harness.whatsapp.sent
      .filter((message) => message.to === CHIDI)
      .map((message) => message.text)
      .join("\n");

    expect(toChidi).not.toContain(ACCOUNT);
  });

  it("leaves a different account on a different number alone", async () => {
    // One Binding per account, not one per Customer. A Customer with a savings
    // and a current account may legitimately hold two, on two handsets.
    await enroll(CHIDI, ACCOUNT);
    await enroll(CHIDIS_NEW_PHONE, OTHER_ACCOUNT);

    expect(await isLinked(CHIDI)).toBe(true);
    expect(await isLinked(CHIDIS_NEW_PHONE)).toBe(true);
  });

  it("records both halves of the swap", async () => {
    await enroll(CHIDI);
    await enroll(CHIDIS_NEW_PHONE);

    const actions = (await auditRows()).map((row) => row.action);
    expect(actions).toContain("binding.revoked");
    expect(actions).toContain("binding.created");
    expect(actions).toContain("customer.notified");
  });
});

// --- Dormancy ----------------------------------------------------------------

describe("a Binding nobody has used", () => {
  it("stops reaching the account after ninety silent days", async () => {
    await enroll(CHIDI);

    harness.clock.advance(90 * DAY);

    expect(await isLinked(CHIDI)).toBe(false);
  });

  it("survives as long as the Customer keeps talking to us", async () => {
    await enroll(CHIDI);

    harness.clock.advance(89 * DAY);
    expect(await isLinked(CHIDI)).toBe(true);

    // Which itself was Customer-initiated contact, so the clock starts again.
    harness.clock.advance(89 * DAY);
    expect(await isLinked(CHIDI)).toBe(true);
  });

  it("is not kept alive by a delivery receipt for a message we sent", async () => {
    // The failure this rule exists to prevent: a notification to a number the
    // operator has already recycled, refreshing exactly the Binding that
    // dormancy is there to kill.
    await enroll(CHIDI);
    harness.clock.advance(89 * DAY);

    await postWebhook(harness, deliveryReceiptPayload({ ...envelope, status: "delivered" }));
    await postWebhook(harness, deliveryReceiptPayload({ ...envelope, status: "read" }));

    harness.clock.advance(2 * DAY);
    expect(await isLinked(CHIDI)).toBe(false);
  });
});

describe("renewal", () => {
  const beginRenewal = async (): Promise<string> => {
    await say(CHIDI, "what's my balance");
    await tap(CHIDI, "enroll_link");
    return flowTokenFrom(harness);
  };

  it("asks for a code and not for the account number again", async () => {
    await enroll(CHIDI);
    harness.clock.advance(90 * DAY);

    const token = await beginRenewal();

    // Identified from the Binding they already hold. One screen, not the front
    // door — the threat is "a different human now holds this number", and a code
    // to the contact on record tests exactly that.
    expect((await init(token)).screen).toBe("CHOOSE_DESTINATION");
  });

  it("tells the Bank it is a renewal, so the message can be worded for it", async () => {
    // A renewal code always reaches somebody who has not used the service in
    // three months. It lands cold, and reads exactly like phishing unless the
    // Bank can word it as what it is.
    await enroll(CHIDI);
    harness.clock.advance(90 * DAY);
    const token = await beginRenewal();

    await init(token);
    await submit(token, "CHOOSE_DESTINATION", { destination_id: "d1" });

    expect(harness.bankIdentity.codesSent.at(-1)?.purpose).toBe("renewal");
  });

  it("puts the Customer back in reach of their account", async () => {
    await enroll(CHIDI);
    harness.clock.advance(90 * DAY);
    const token = await beginRenewal();

    await init(token);
    await submit(token, "CHOOSE_DESTINATION", { destination_id: "d1" });
    const done = await submit(token, "CODE", { code: CODE });

    expect(done.screen).toBe("DONE");
    expect(await isLinked(CHIDI)).toBe(true);
  });

  it("does not ask for a new PIN, and does not change the one they have", async () => {
    // A renewal proves the number still belongs to the same person. It says
    // nothing about the PIN, and forcing a new one every ninety days would push
    // Customers toward writing it down.
    await enroll(CHIDI);
    harness.clock.advance(90 * DAY);
    const before = (await auditRows()).filter((row) => row.action === "pin.set").length;

    const token = await beginRenewal();
    await init(token);
    await submit(token, "CHOOSE_DESTINATION", { destination_id: "d1" });
    const done = await submit(token, "CODE", { code: CODE });

    expect(done.screen).toBe("DONE");
    expect((await auditRows()).filter((row) => row.action === "pin.set")).toHaveLength(before);
  });

  it("is recorded as a renewal rather than as a new Binding", async () => {
    await enroll(CHIDI);
    harness.clock.advance(90 * DAY);
    const bindingsCreated = (await auditRows()).filter(
      (row) => row.action === "binding.created",
    ).length;

    const token = await beginRenewal();
    await init(token);
    await submit(token, "CHOOSE_DESTINATION", { destination_id: "d1" });
    await submit(token, "CODE", { code: CODE });

    const after = await auditRows();
    expect(after.filter((row) => row.action === "binding.renewed")).toHaveLength(1);
    expect(after.filter((row) => row.action === "binding.created")).toHaveLength(bindingsCreated);
  });
});

// --- Unlinking ---------------------------------------------------------------

describe("a Customer unlinking themselves", () => {
  beforeEach(() => {
    harness.groq.setResolver((said) =>
      /unlink|stop/i.test(said) ? { kind: "unlink" } : { kind: "check_balance" },
    );
  });

  it("is asked to confirm rather than taken at the model's word", async () => {
    // A model that can revoke a Binding is one injected instruction away from
    // revoking it. The model may propose; only a tap acts.
    await enroll(CHIDI);

    await say(CHIDI, "unlink my number");

    expect(harness.whatsapp.sent.at(-1)?.text).toContain("Are you sure");
    expect(await isLinked(CHIDI)).toBe(true);
  });

  it("is unlinked when they tap yes", async () => {
    await enroll(CHIDI);
    await say(CHIDI, "unlink my number");

    const replies = await tap(CHIDI, "unlink_confirm");

    expect(replies.at(-1)).toContain("no longer linked");
    expect(await isLinked(CHIDI)).toBe(false);
  });

  it("is left alone when they tap no", async () => {
    await enroll(CHIDI);
    await say(CHIDI, "stop whatsapp banking");

    const replies = await tap(CHIDI, "unlink_cancel");

    expect(replies.at(-1)).toContain("still linked");
    expect(await isLinked(CHIDI)).toBe(true);
  });

  it("can link again afterwards", async () => {
    await enroll(CHIDI);
    await say(CHIDI, "unlink my number");
    await tap(CHIDI, "unlink_confirm");

    await enroll(CHIDI);
    expect(await isLinked(CHIDI)).toBe(true);
  });
});

// --- A forgotten PIN ---------------------------------------------------------

describe("a Customer who has forgotten their PIN", () => {
  beforeEach(() => {
    harness.groq.setResolver((said) =>
      /pin/i.test(said) ? { kind: "reset_pin" } : { kind: "check_balance" },
    );
  });

  it("resets it over the same code path, with no Support Officer anywhere", async () => {
    await enroll(CHIDI);

    await say(CHIDI, "I have forgotten my PIN");
    const token = flowTokenFrom(harness);

    // No account number screen — they are already linked, and the code goes to
    // the contact on record, which is the same root of trust that authorised the
    // enrollment in the first place.
    expect((await init(token)).screen).toBe("CHOOSE_DESTINATION");
    await submit(token, "CHOOSE_DESTINATION", { destination_id: "d1" });
    expect(harness.bankIdentity.codesSent.at(-1)?.purpose).toBe("pin_reset");

    expect((await submit(token, "CODE", { code: CODE })).screen).toBe("SET_PIN");
    const done = await submit(token, "SET_PIN", { pin: "9876", pin_confirmation: "9876" });

    expect(done.screen).toBe("DONE");
    expect(String(done.data["message"])).toContain("PIN has been changed");
  });

  it("leaves the Binding exactly where it was", async () => {
    await enroll(CHIDI);
    const bindingsCreated = (await auditRows()).filter(
      (row) => row.action === "binding.created",
    ).length;

    await say(CHIDI, "reset my pin");
    const token = flowTokenFrom(harness);
    await init(token);
    await submit(token, "CHOOSE_DESTINATION", { destination_id: "d1" });
    await submit(token, "CODE", { code: CODE });
    await submit(token, "SET_PIN", { pin: "9876", pin_confirmation: "9876" });

    expect((await auditRows()).filter((row) => row.action === "binding.created")).toHaveLength(
      bindingsCreated,
    );
    expect(await isLinked(CHIDI)).toBe(true);
  });

  it("is told plainly when there is nothing to reset", async () => {
    const replies = await say(CHIDI, "I forgot my pin");

    expect(replies.at(-1)).toContain("Do you have a bank account");
  });
});

// --- What the record holds ---------------------------------------------------

describe("what a Binding holds", () => {
  it("carries no name, no contact details and no customer identifier", async () => {
    await enroll(CHIDI);

    // Asserted where the Bank would look: the audit trail of the Binding's own
    // creation. A name or a phone number appearing anywhere in it would mean
    // one had entered the system, which is what ADR-0006 exists to prevent.
    const created = (await auditRows()).find((row) => row.action === "binding.created");

    expect(created).toBeDefined();
    expect(JSON.stringify(created)).not.toMatch(/CHIDI|OKAFOR|6655|customerId/i);
  });
});

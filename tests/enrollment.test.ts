import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HOUR, chosePayload, saidPayload } from "@avni/fakes";

import {
  exchangeFlow,
  flowTokenFrom,
  postWebhook,
  startHarness,
  waitForReplies,
  type Harness,
} from "./harness";

/**
 * The front door, driven the way a Customer drives it.
 *
 * Everything below goes in through the Platform's webhook or the Middleware's
 * Flows endpoint and asserts what the **Customer** observes. Nothing reaches
 * inside to check that a particular method was called — and the tests that
 * matter most here are the ones an attacker would write: probe an account
 * number, read the difference, and see whether there is one.
 */

const CUSTOMER = "2348012345678";
const SECOND_HANDSET = "2348055555555";
const ACCOUNT = "2024000153";
/** Well-formed under bank code 030, and an account the Bank does not hold. */
const UNKNOWN_ACCOUNT = "2200112230";
/** One digit out. Caught before anything leaves the platform. */
const MISTYPED = "2024000154";
const CODE = "482913";
const PIN = "4821";

const envelope = { phoneNumberId: "test-phone-number-id", from: CUSTOMER };

let harness: Harness;

beforeEach(async () => {
  harness = await startHarness({
    accounts: [{ accountNumber: ACCOUNT, availableBalance: 250_000 }],
    identityAccounts: [
      {
        accountNumber: ACCOUNT,
        code: CODE,
        destinations: [
          { id: "d1", kind: "phone", masked: "••• ••• 6655" },
          { id: "d2", kind: "email", masked: "c•••@g•••.com" },
        ],
      },
    ],
  });
});

afterEach(async () => {
  await harness?.stop();
});

// --- Driving the Flow --------------------------------------------------------

/** Gets the Customer as far as holding a sealed surface, and returns its token. */
const openTheFlow = async (from = CUSTOMER, text = "what's my balance"): Promise<string> => {
  const before = harness.whatsapp.sent.length;
  await postWebhook(harness, saidPayload({ phoneNumberId: "test-phone-number-id", from, text }));
  await waitForReplies(harness, before + 1);

  await postWebhook(
    harness,
    chosePayload({ phoneNumberId: "test-phone-number-id", from, id: "enroll_link" }),
  );
  await waitForReplies(harness, before + 2);

  return flowTokenFrom(harness);
};

const init = (token: string) =>
  exchangeFlow(harness, { version: "3.0", action: "INIT", screen: "", data: {}, flow_token: token });

const submit = (token: string, screen: string, data: Record<string, unknown>) =>
  exchangeFlow(harness, { version: "3.0", action: "data_exchange", screen, data, flow_token: token });

/**
 * A destination **as the screen carries it**, which is not the shape the Bank's
 * identity API returns. The masked label is presented as `title` because that
 * is the field a published Flow's `RadioButtonsGroup` binds to, and `kind` is
 * dropped because nothing on the screen uses it.
 */
interface Destination {
  id: string;
  title: string;
}

const destinationsOf = (data: Record<string, unknown>): Destination[] =>
  (data["destinations"] ?? []) as Destination[];

/**
 * Asks for a balance, which is the only thing a Binding is observable through.
 *
 * **A number with no Binding is greeted rather than answered** — the Platform
 * asks whether they bank here at all before any model reads their words — so
 * the greeting is what "not linked" looks like from outside.
 */
const isLinked = async (from = CUSTOMER): Promise<boolean> => {
  const before = harness.whatsapp.sent.length;
  await postWebhook(
    harness,
    saidPayload({ phoneNumberId: "test-phone-number-id", from, text: "what's my balance" }),
  );
  const replies = await waitForReplies(harness, before + 1);
  return !(replies.at(-1) ?? "").includes("Do you have a bank account");
};

// --- The happy path ----------------------------------------------------------

describe("a Customer links their number", () => {
  it("walks account number, destination, code, PIN — and is told they are linked", async () => {
    const token = await openTheFlow();

    expect((await init(token)).screen).toBe("IDENTIFY");

    const destinations = await submit(token, "IDENTIFY", { account_number: ACCOUNT });
    expect(destinations.screen).toBe("CHOOSE_DESTINATION");
    expect(destinationsOf(destinations.data).map((d) => d.title)).toEqual([
      "••• ••• 6655",
      "c•••@g•••.com",
    ]);

    expect((await submit(token, "CHOOSE_DESTINATION", { destination_id: "d1" })).screen).toBe(
      "CODE",
    );

    // The code goes to the contact on record. The platform never saw it.
    expect(harness.bankIdentity.codesSent).toEqual([
      { accountNumber: ACCOUNT, destinationId: "d1", purpose: "enrollment", code: CODE },
    ]);

    expect((await submit(token, "CODE", { code: CODE })).screen).toBe("SET_PIN");

    const done = await submit(token, "SET_PIN", { pin: PIN, pin_confirmation: PIN });
    expect(done.screen).toBe("DONE");
    // The screen says it worked; what the Customer can now *do* is said in the
    // conversation a moment later, beside the menu that does it.
    expect(done.data["message"]).toContain("Congratulations");
    expect(done.data["message"]).toContain("Example MFB");
  });

  it("can then ask for a balance, in the conversation they were already in", async () => {
    const token = await openTheFlow();
    await submit(token, "IDENTIFY", { account_number: ACCOUNT });
    await submit(token, "CHOOSE_DESTINATION", { destination_id: "d1" });
    await submit(token, "CODE", { code: CODE });
    await submit(token, "SET_PIN", { pin: PIN, pin_confirmation: PIN });

    const before = harness.whatsapp.sent.length;
    await postWebhook(harness, saidPayload({ ...envelope, text: "what's my balance" }));
    const replies = await waitForReplies(harness, before + 1);

    expect(replies.at(-1)).toBe("Your available balance is ₦250,000.");
  });

  it("is not linked until the PIN is set", async () => {
    // A Binding with no PIN can read a balance and authorise nothing, so
    // stopping at the code screen must leave nothing behind at all.
    const token = await openTheFlow();
    await submit(token, "IDENTIFY", { account_number: ACCOUNT });
    await submit(token, "CHOOSE_DESTINATION", { destination_id: "d1" });
    await submit(token, "CODE", { code: CODE });

    const before = harness.whatsapp.sent.length;
    await postWebhook(harness, saidPayload({ ...envelope, text: "balance" }));
    const replies = await waitForReplies(harness, before + 1);

    // Greeted as a stranger, because a Binding without a PIN is no Binding.
    expect(replies.at(-1)).toContain("Do you have a bank account");
    expect(harness.bankOne.requests).toHaveLength(0);
  });

  it("is refused a PIN that is not four digits, and one typed twice differently", async () => {
    const token = await openTheFlow();
    await submit(token, "IDENTIFY", { account_number: ACCOUNT });
    await submit(token, "CHOOSE_DESTINATION", { destination_id: "d1" });
    await submit(token, "CODE", { code: CODE });

    const short = await submit(token, "SET_PIN", { pin: "48", pin_confirmation: "48" });
    expect(short.screen).toBe("SET_PIN");
    expect(String(short.data["error_message"])).toContain("4 digits");

    const mismatched = await submit(token, "SET_PIN", { pin: PIN, pin_confirmation: "9999" });
    expect(mismatched.screen).toBe("SET_PIN");
    expect(String(mismatched.data["error_message"])).toContain("not the same");
  });
});

// --- The mistyped digit ------------------------------------------------------

describe("a Customer who mistypes one digit", () => {
  it("is told so on the same screen, before any call leaves the platform", async () => {
    const token = await openTheFlow();

    const answer = await submit(token, "IDENTIFY", { account_number: MISTYPED });

    expect(answer.screen).toBe("IDENTIFY");
    expect(String(answer.data["error_message"])).toContain("check it");
    expect(harness.bankIdentity.requests).toHaveLength(0);
  });

  it("does not spend an attempt on it", async () => {
    // Without the local check, one typo costs the whole silent walk and an
    // hour's lockout — which is the cruelty enumeration resistance would
    // otherwise buy at the honest Customer's expense.
    const token = await openTheFlow();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await submit(token, "IDENTIFY", { account_number: MISTYPED });
    }

    expect((await submit(token, "IDENTIFY", { account_number: ACCOUNT })).screen).toBe(
      "CHOOSE_DESTINATION",
    );
  });
});

// --- The attacker ------------------------------------------------------------

describe("an account the Bank does not hold", () => {
  it("walks the identical path, to the identical failure wording", async () => {
    const probe = await openTheFlow();
    await submit(probe, "IDENTIFY", { account_number: UNKNOWN_ACCOUNT });
    await submit(probe, "CHOOSE_DESTINATION", { destination_id: "d1" });
    const probeFailure = await submit(probe, "CODE", { code: "000000" });

    // And now the same walk against an account that does exist, with a code
    // that is simply wrong.
    const real = await openTheFlow(SECOND_HANDSET, "link me");
    await submit(real, "IDENTIFY", { account_number: ACCOUNT });
    await submit(real, "CHOOSE_DESTINATION", { destination_id: "d1" });
    const realFailure = await submit(real, "CODE", { code: "000000" });

    expect(probeFailure.screen).toBe(realFailure.screen);
    expect(probeFailure.data).toEqual(realFailure.data);
  });

  it("still gets a destination screen, and a code screen", async () => {
    const token = await openTheFlow();

    const destinations = await submit(token, "IDENTIFY", { account_number: UNKNOWN_ACCOUNT });
    expect(destinations.screen).toBe("CHOOSE_DESTINATION");
    expect(destinationsOf(destinations.data).length).toBeGreaterThan(0);

    const first = destinationsOf(destinations.data)[0] as Destination;
    expect((await submit(token, "CHOOSE_DESTINATION", { destination_id: first.id })).screen).toBe(
      "CODE",
    );
  });

  it("has no code sent for it, and the Bank is never asked to send one", async () => {
    const token = await openTheFlow();
    await submit(token, "IDENTIFY", { account_number: UNKNOWN_ACCOUNT });
    await submit(token, "CHOOSE_DESTINATION", { destination_id: "d1" });

    expect(harness.bankIdentity.codesSent).toHaveLength(0);
  });

  it("shows identical decoys on a second probe", async () => {
    // Random decoys would be the oracle: two probes of the same number that
    // differed, when nothing else in the system differs.
    const first = await openTheFlow();
    const one = await submit(first, "IDENTIFY", { account_number: UNKNOWN_ACCOUNT });

    const second = await openTheFlow(SECOND_HANDSET, "link");
    const other = await submit(second, "IDENTIFY", { account_number: UNKNOWN_ACCOUNT });

    expect(destinationsOf(one.data)).toEqual(destinationsOf(other.data));
  });

  it("shows decoys shaped exactly like the Bank's own masked labels", async () => {
    const token = await openTheFlow();
    const screen = await submit(token, "IDENTIFY", { account_number: UNKNOWN_ACCOUNT });

    for (const destination of destinationsOf(screen.data)) {
      expect(destination.title).toMatch(/^(••• ••• \d{4}|[a-z]•••@[a-z]•••\.com)$/);
    }
  });

  it("is never shown the account holder's name, at any point", async () => {
    const token = await openTheFlow();
    await submit(token, "IDENTIFY", { account_number: ACCOUNT });
    const chosen = await submit(token, "CHOOSE_DESTINATION", { destination_id: "d1" });

    // The prior implementation linked accounts on name confirmation alone —
    // account number in, real holder name out, with no verification at all.
    const everythingSeen = JSON.stringify([chosen, harness.whatsapp.transcript()]);
    expect(everythingSeen).not.toMatch(/CHIDI|OKAFOR|EXAMPLE CUSTOMER/i);
  });
});

describe("when the Bank's identity service is down", () => {
  /**
   * The condition enumeration resistance is easiest to get wrong in.
   *
   * Every step below is asserted to behave *identically* for a real account and
   * an unknown one. The first version of this slice skipped the Bank entirely on
   * the decoy walk, which looked like a saving and meant that during an outage a
   * real account said "try again shortly" while an unknown one walked on — an
   * oracle that lasts exactly as long as the outage.
   */
  const bothWalksAt = async (
    step: (token: string) => Promise<{ screen: string; data: Record<string, unknown> }>,
    upTo: (token: string, accountNumber: string) => Promise<void>,
  ) => {
    const real = await openTheFlow();
    await upTo(real, ACCOUNT);

    const probe = await openTheFlow(SECOND_HANDSET, "link");
    await upTo(probe, UNKNOWN_ACCOUNT);

    harness.bankIdentity.goDown(true);
    return { real: await step(real), probe: await step(probe) };
  };

  it("says the same thing on the destination screen either way", async () => {
    const { real, probe } = await bothWalksAt(
      (token) => submit(token, "CHOOSE_DESTINATION", { destination_id: "d1" }),
      async (token, accountNumber) => {
        await submit(token, "IDENTIFY", { account_number: accountNumber });
      },
    );

    expect(real.screen).toBe("UNAVAILABLE");
    expect(probe).toEqual(real);
  });

  it("says the same thing on the code screen either way", async () => {
    const { real, probe } = await bothWalksAt(
      (token) => submit(token, "CODE", { code: CODE }),
      async (token, accountNumber) => {
        await submit(token, "IDENTIFY", { account_number: accountNumber });
        await submit(token, "CHOOSE_DESTINATION", { destination_id: "d1" });
      },
    );

    expect(real.screen).toBe("UNAVAILABLE");
    expect(probe).toEqual(real);
  });

  it("does not spend an attempt on an outage that was not the Customer's fault", async () => {
    const token = await openTheFlow();
    await submit(token, "IDENTIFY", { account_number: ACCOUNT });
    await submit(token, "CHOOSE_DESTINATION", { destination_id: "d1" });

    harness.bankIdentity.goDown(true);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect((await submit(token, "CODE", { code: CODE })).screen).toBe("UNAVAILABLE");
    }
    harness.bankIdentity.goDown(false);

    // Three of those would otherwise lock a Customer out for an hour over a
    // failure that was never theirs.
    expect((await submit(token, "CODE", { code: CODE })).screen).toBe("SET_PIN");
  });

  it("tells the Customer nothing about the Bank", async () => {
    const token = await openTheFlow();
    harness.bankIdentity.goDown(true);

    const answer = await submit(token, "IDENTIFY", { account_number: ACCOUNT });

    expect(JSON.stringify(answer)).not.toMatch(/HTTP|500|identity|Bank/i);
  });
});

describe("a Bank that contradicts itself", () => {
  it("will not mint a Binding for an account it said it does not hold", async () => {
    // `resolve` 404s and `verify-otp` then answers `verified: true`. That is a
    // Bank bug or a compromised identity service, and either way the platform's
    // own earlier reading has to win — otherwise one misbehaving upstream
    // response binds a WhatsApp number to an account nobody confirmed exists.
    const token = await openTheFlow();
    await submit(token, "IDENTIFY", { account_number: UNKNOWN_ACCOUNT });

    // The Bank starts holding it — but only after it told us it did not, so a
    // real code is now genuinely issued and genuinely verifies.
    harness.bankIdentity.setAccount({
      accountNumber: UNKNOWN_ACCOUNT,
      code: CODE,
      destinations: [{ id: "d1", kind: "phone", masked: "••• ••• 0000" }],
    });
    await submit(token, "CHOOSE_DESTINATION", { destination_id: "d1" });

    const answer = await submit(token, "CODE", { code: CODE });

    expect(answer.screen).not.toBe("SET_PIN");
    expect(await isLinked()).toBe(false);
  });
});

describe("three attempts, then an hour", () => {
  const walkToTheCodeScreen = async (from = CUSTOMER): Promise<string> => {
    const token = await openTheFlow(from, "link my account");
    await submit(token, "IDENTIFY", { account_number: ACCOUNT });
    await submit(token, "CHOOSE_DESTINATION", { destination_id: "d1" });
    return token;
  };

  it("counts down, then locks out on the third", async () => {
    const token = await walkToTheCodeScreen();

    expect(String((await submit(token, "CODE", { code: "111111" })).data["error_message"])).toContain(
      "2 attempts left",
    );
    expect(String((await submit(token, "CODE", { code: "222222" })).data["error_message"])).toContain(
      "1 attempt left",
    );
    expect((await submit(token, "CODE", { code: "333333" })).screen).toBe("LOCKED");
  });

  it("refuses the right code while locked out", async () => {
    const token = await walkToTheCodeScreen();
    for (const wrong of ["111111", "222222", "333333"]) await submit(token, "CODE", { code: wrong });

    expect((await submit(token, "CODE", { code: CODE })).screen).toBe("LOCKED");
  });

  it("is not reset by closing the Flow and starting again", async () => {
    // The counter is on the WhatsApp number, not on the walk. Scoped to one
    // enrollment it would reset every time the Customer reopened the Flow, and
    // the silent probe would be free.
    const token = await walkToTheCodeScreen();
    await submit(token, "CODE", { code: "111111" });
    await submit(token, "CODE", { code: "222222" });

    const fresh = await walkToTheCodeScreen();
    expect((await submit(fresh, "CODE", { code: "333333" })).screen).toBe("LOCKED");
  });

  it("lets the Customer in again an hour later", async () => {
    const token = await walkToTheCodeScreen();
    for (const wrong of ["111111", "222222", "333333"]) await submit(token, "CODE", { code: wrong });

    harness.clock.advance(HOUR);

    const fresh = await walkToTheCodeScreen();
    expect((await submit(fresh, "CODE", { code: CODE })).screen).toBe("SET_PIN");
  });

  it("does not lock out a different number", async () => {
    const token = await walkToTheCodeScreen();
    for (const wrong of ["111111", "222222", "333333"]) await submit(token, "CODE", { code: wrong });

    const other = await walkToTheCodeScreen(SECOND_HANDSET);
    expect((await submit(other, "CODE", { code: CODE })).screen).toBe("SET_PIN");
  });
});

// --- The payload rule --------------------------------------------------------

describe("the payload rule", () => {
  it("ignores an account number echoed back on a later screen", async () => {
    // Flows encrypt with a key the *client* generates, so the handset owns that
    // plaintext entirely. Which account is being enrolled is read from the
    // session the flow token names, and nothing the payload says can move it.
    const token = await openTheFlow();
    await submit(token, "IDENTIFY", { account_number: ACCOUNT });
    await submit(token, "CHOOSE_DESTINATION", { destination_id: "d1", account_number: "9999999999" });
    await submit(token, "CODE", { code: CODE, account_number: "9999999999" });
    await submit(token, "SET_PIN", {
      pin: PIN,
      pin_confirmation: PIN,
      account_number: "9999999999",
    });

    const before = harness.whatsapp.sent.length;
    await postWebhook(harness, saidPayload({ ...envelope, text: "balance" }));
    await waitForReplies(harness, before + 1);

    expect(harness.bankOne.requests.at(-1)?.query["accountNumber"]).toBe(ACCOUNT);
  });

  it("refuses a flow token nobody was ever given", async () => {
    const answer = await init("a-token-that-was-never-minted");

    expect(answer.screen).toBe("UNAVAILABLE");
  });

  it("refuses a half-finished walk picked up half an hour later", async () => {
    // The token lives on a handset and a session left at the PIN screen has
    // already passed the code. Leaving it resumable forever makes that handset a
    // standing invitation.
    const token = await openTheFlow();
    await submit(token, "IDENTIFY", { account_number: ACCOUNT });
    await submit(token, "CHOOSE_DESTINATION", { destination_id: "d1" });
    await submit(token, "CODE", { code: CODE });

    harness.clock.advance(31 * 60 * 1000);

    expect((await submit(token, "SET_PIN", { pin: PIN, pin_confirmation: PIN })).screen).toBe(
      "UNAVAILABLE",
    );
  });

  it("refuses a step out of order", async () => {
    const token = await openTheFlow();

    // Jumping straight to the PIN, with no account and no code.
    expect((await submit(token, "SET_PIN", { pin: PIN, pin_confirmation: PIN })).screen).toBe(
      "UNAVAILABLE",
    );
  });
});

// --- What the audit table is told -------------------------------------------

describe("the audit log, which is the only place the causes are told apart", () => {
  const auditFor = async (accountNumber: string) => {
    const { token } = await harness.signInStaff("administrator");
    const response = await fetch(
      `${harness.middlewareUrl}/dashboard/audit?accountNumber=${accountNumber}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    const body = (await response.json()) as {
      entries: { action: string; outcome: string; detail: Record<string, unknown> }[];
    };
    return body.entries;
  };

  it("says a wrong account number was a wrong account number", async () => {
    const token = await openTheFlow();
    await submit(token, "IDENTIFY", { account_number: UNKNOWN_ACCOUNT });
    await submit(token, "CHOOSE_DESTINATION", { destination_id: "d1" });
    await submit(token, "CODE", { code: "111111" });

    const entries = await auditFor(UNKNOWN_ACCOUNT);
    const submitted = entries.find((entry) => entry.action === "enrollment.account_submitted");

    expect(submitted?.outcome).toBe("refused");
    expect(String(submitted?.detail["reason"])).toContain("does not hold this account");
  });

  it("says a wrong code was a wrong code", async () => {
    const token = await openTheFlow();
    await submit(token, "IDENTIFY", { account_number: ACCOUNT });
    await submit(token, "CHOOSE_DESTINATION", { destination_id: "d1" });
    await submit(token, "CODE", { code: "111111" });

    const entries = await auditFor(ACCOUNT);
    const checked = entries.find((entry) => entry.action === "enrollment.code_checked");

    expect(checked?.outcome).toBe("refused");
    expect(checked?.detail["reason"]).toBe("incorrect");
  });

  it("records the mistyped account number without ever calling the Bank", async () => {
    const token = await openTheFlow();
    await submit(token, "IDENTIFY", { account_number: MISTYPED });

    const { token: staffToken } = await harness.signInStaff("administrator");
    const response = await fetch(
      `${harness.middlewareUrl}/dashboard/audit?action=enrollment.account_submitted`,
      { headers: { authorization: `Bearer ${staffToken}` } },
    );
    const body = (await response.json()) as { entries: { detail: Record<string, unknown> }[] };

    expect(String(body.entries[0]?.detail["reason"])).toContain("NUBAN check digit");
  });

  it("never writes the code or the PIN into a row", async () => {
    const token = await openTheFlow();
    await submit(token, "IDENTIFY", { account_number: ACCOUNT });
    await submit(token, "CHOOSE_DESTINATION", { destination_id: "d1" });
    await submit(token, "CODE", { code: CODE });
    await submit(token, "SET_PIN", { pin: PIN, pin_confirmation: PIN });

    const entries = await auditFor(ACCOUNT);
    const everything = JSON.stringify(entries);

    expect(everything).not.toContain(CODE);
    expect(everything).not.toContain(PIN);
  });
});

// --- The Transaction PIN's blast radius --------------------------------------

describe("the Transaction PIN", () => {
  it("never passes through the Platform", async () => {
    const token = await openTheFlow();
    await submit(token, "IDENTIFY", { account_number: ACCOUNT });
    await submit(token, "CHOOSE_DESTINATION", { destination_id: "d1" });
    await submit(token, "CODE", { code: CODE });
    await submit(token, "SET_PIN", { pin: PIN, pin_confirmation: PIN });

    // Everything the Platform sent anywhere, and everything the model was shown.
    const everythingTheModelSaw = harness.groq.calls.map((call) => call.prompt).join("\n");
    const everythingTheCustomerSaw = harness.whatsapp.transcript().join("\n");

    expect(everythingTheModelSaw).not.toContain(PIN);
    expect(everythingTheCustomerSaw).not.toContain(PIN);
    expect(everythingTheModelSaw).not.toContain(ACCOUNT);
    expect(everythingTheModelSaw).not.toContain(CODE);
  });
});

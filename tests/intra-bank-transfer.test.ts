import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { saidPayload } from "@avni/fakes";

import {
  BANK_CODE,
  BANK_NAME,
  PHONE_NUMBER_ID,
  exchangeFlow,
  flowTokenFrom,
  postWebhook,
  startHarness,
  waitForReplies,
  type Harness,
  type HarnessOptions,
} from "./harness";

/**
 * Sending money, driven the way a Customer drives it.
 *
 * Everything below goes in through the Platform's webhook or the Middleware's
 * Flows endpoint, and asserts what the **Customer** or the **Bank** observes.
 * The rule of thumb this file was written against: *if a test would still pass
 * after the money went to the wrong account, it is testing the wrong thing.*
 *
 * The attacks are the tests that matter most here, and they are grouped at the
 * bottom under their own heading. The first of them — a tampered `amount` in the
 * returned payload — is the concrete ₦900,000 debit the published prior-art Flow
 * permits, and it is the reason this slice exists in the shape it does.
 */

const CUSTOMER = "2348012345678";
const ACCOUNT = "2024000153";
const DESTINATION = "2124955312";
const RECIPIENT = "CHIDI EZE";
const PIN = "4821";
const AMOUNT = 2000;

const envelope = { phoneNumberId: PHONE_NUMBER_ID, from: CUSTOMER };

let harness: Harness;

const start = async (options: HarnessOptions = {}): Promise<void> => {
  harness = await startHarness({
    accounts: [{ accountNumber: ACCOUNT, availableBalance: 250_000 }],
    names: [{ accountNumber: DESTINATION, bankCode: BANK_CODE, name: RECIPIENT }],
    ...options,
  });
  await harness.seedBinding(CUSTOMER, ACCOUNT);
  await harness.seedPin(ACCOUNT, PIN);
};

beforeEach(async () => {
  await start();
});

afterEach(async () => {
  await harness?.stop();
});

// --- Driving it --------------------------------------------------------------

/** What the Orchestration Layer extracted. Shape guaranteed, values never. */
const saysTransfer = (
  amount: number,
  accountNumber: string,
  bankName = "",
): void => {
  harness.groq.setResolver(() => ({
    kind: "transfer_to_account",
    amount,
    accountNumber,
    bankName,
  }));
};

/** Says it, and returns everything the Customer has been sent since. */
const say = async (text: string): Promise<readonly string[]> => {
  const before = harness.whatsapp.sent.length;
  await postWebhook(harness, saidPayload({ ...envelope, text }));
  const replies = await waitForReplies(harness, before + 1);
  return replies.slice(before);
};

/** Asks for a transfer and comes back holding the sealed surface's token. */
const askToSend = async (
  amount = AMOUNT,
  accountNumber = DESTINATION,
  bankName = "",
): Promise<string> => {
  saysTransfer(amount, accountNumber, bankName);
  await say(`send ${amount} to ${accountNumber}`);
  return flowTokenFrom(harness);
};

const open = (token: string) =>
  exchangeFlow(harness, { version: "3.0", action: "INIT", screen: "", data: {}, flow_token: token });

/**
 * Submits the Confirmation screen. `data` is whatever the handset chose to send
 * — which is the point of taking it as an argument.
 */
const submit = (token: string, data: Record<string, unknown>) =>
  exchangeFlow(harness, {
    version: "3.0",
    action: "data_exchange",
    screen: "CONFIRM",
    data,
    flow_token: token,
  });

const transferSent = () => harness.bankOne.transfers.at(-1);

/** The body of the last `LocalFundsTransfer`, as it arrived on the wire. */
const transferRequest = (): Record<string, unknown> =>
  (harness.bankOne.requests
    .filter((request) => request.path.endsWith("/LocalFundsTransfer"))
    .at(-1)?.body ?? {}) as Record<string, unknown>;

// --- The journey -------------------------------------------------------------

describe("a Customer sends money to an account number they state", () => {
  it("confirms, takes the PIN, moves the money, and says so in the same conversation", async () => {
    const token = await askToSend();

    const confirm = await open(token);
    expect(confirm.screen).toBe("CONFIRM");

    const done = await submit(token, { pin: PIN });
    expect(done.screen).toBe("DONE");
    expect(done.data["message"]).toContain("Sent ₦2,000 to CHIDI EZE");

    // Told in the conversation, not only on the screen the Flow closed.
    const replies = await waitForReplies(harness, 2);
    expect(replies.at(-1)).toContain("Sent ₦2,000 to CHIDI EZE");

    expect(transferSent()).toMatchObject({
      fromAccountNumber: ACCOUNT,
      toAccountNumber: DESTINATION,
      // Naira, and never divided by 100.
      amount: AMOUNT,
    });
  });

  it("shows the amount, both accounts, the bank and the name from name enquiry", async () => {
    const confirm = await open(await askToSend());

    expect(confirm.data).toMatchObject({
      amount: "₦2,000",
      destination_account: DESTINATION,
      destination_bank: BANK_NAME,
      source_account: ACCOUNT,
      // **The single most important value on the screen.** It comes from name
      // enquiry, and there is no path by which a Customer-supplied label reaches
      // it.
      destination_name: RECIPIENT,
    });
  });

  it("states no fee it was never given, with no tariff configured", async () => {
    const confirm = await open(await askToSend());

    // The prior art's screen read "Fee: NGN 30.00", hardcoded, from a different
    // product entirely. An invented fee on a licensed bank's confirmation screen
    // is a compliance problem, so with nowhere for a figure to come from the
    // screen says so and shows no digits at all.
    const fee = String(confirm.data["fee_note"]);
    expect(fee).toBe("Fees apply per your account tariff.");
    expect(fee).not.toMatch(/\d/);
  });

  it("moves nothing until the PIN is entered", async () => {
    const token = await askToSend();
    await open(token);

    // The Confirmation screen has been rendered and nothing has been dispatched.
    // There is no confirm-only tier and no amount below which the PIN is
    // skipped: a Binding lives on a handset, and one tap is what an unlocked
    // stolen phone has.
    expect(harness.bankOne.transfers).toEqual([]);

    await submit(token, { pin: "9999" });
    expect(harness.bankOne.transfers).toEqual([]);
  });

  it("sends the PIN through the sealed channel and never into the transcript", async () => {
    const token = await askToSend();
    await submit(token, { pin: PIN });

    for (const message of harness.whatsapp.sent) {
      expect(JSON.stringify(message.raw)).not.toContain(PIN);
    }
    // The Platform runs the model, and the model is shown `said` text only. A
    // Transaction PIN reaching it at all is what ADR-0007 exists to prevent.
    for (const call of harness.groq.calls) expect(call.prompt).not.toContain(PIN);
  });

  it("authenticates the intra-bank endpoint with AuthenticationKey, not Token", async () => {
    await submit(await askToSend(), { pin: PIN });

    const body = transferRequest();
    // Same token *value*, different field *name*, on this endpoint alone. The
    // fake refuses the other spelling, so a transfer that succeeded is a
    // transfer that spelled it right — and this asserts the wire directly, so
    // the reason is legible when it breaks.
    expect(body["AuthenticationKey"]).toBeDefined();
    expect(body["Token"]).toBeUndefined();
  });

  it("mints its own reference, at most 12 characters, and reuses it verbatim", async () => {
    await start({ transfer: { dispatch: "pending", settles: "succeeded" } });
    await submit(await askToSend(), { pin: PIN });

    const reference = String(transferRequest()["RetrievalReference"]);
    expect(reference.length).toBeGreaterThan(0);
    // BankOne rejects anything longer, which rules out a bare UUID.
    expect(reference.length).toBeLessThanOrEqual(12);

    // The same value, not a derived one: a status query about a different
    // string is a question about a different transfer.
    expect(harness.bankOne.statusQueries).toContain(reference);
  });
});

// --- Pending, which is an answer rather than an absence of one ---------------

describe("a transfer BankOne does not answer immediately", () => {
  it("is polled inline and answered in the same turn", async () => {
    await start({ transfer: { dispatch: "pending", pendingQueries: 2, settles: "succeeded" } });

    const done = await submit(await askToSend(), { pin: PIN });

    // Nigerian settlement is measured in seconds and the Customer is still
    // there, so this is answered now rather than by a message an hour later.
    expect(done.screen).toBe("DONE");
    expect(done.data["message"]).toContain("Sent ₦2,000 to CHIDI EZE");
    expect(harness.bankOne.statusQueries.length).toBe(3);
  });

  it("reads a status query that failed as a failure, whatever IsSuccessful says", async () => {
    await start({ transfer: { dispatch: "pending", settles: "failed" } });

    const done = await submit(await askToSend(), { pin: PIN });

    // `{"IsSuccessful": true, "ResponseCode": "06", "Status": "Failed"}` — the
    // query ran, the transfer did not. `06` is in no documented table either, so
    // this also holds that an unrecognised code is a failure rather than a
    // fall-through to success.
    expect(done.data["message"]).toContain("did not go through");
    expect(done.data["message"]).not.toContain("Sent");
  });

  it("is followed up rather than claimed, once the poll bound passes", async () => {
    await start({ transfer: { dispatch: "pending", settles: "never" } });

    const done = await submit(await askToSend(), { pin: PIN });

    expect(done.data["message"]).toContain("has not been confirmed yet");
    expect(done.data["message"]).toContain("following it up");
    expect(done.data["message"]).not.toContain("Sent");

    // First query at 3 seconds, then every 3, giving up at 20. The schedule is a
    // starting value rather than a finding — TSQ is unexercised against BankOne
    // — so it is pinned here where changing it is a decision rather than a drift.
    expect(harness.bankOne.statusQueries).toHaveLength(6);

    // Handoff trigger 1: money may have left the account and the platform
    // cannot say where it went. `tests/handoff.test.ts` drives what the Inbox
    // then does with it; what this journey holds is that the transfer path
    // raises it at all, and does so with the reference an Officer will need.
    const handoffs = await auditRows("handoff.triggered");
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]?.detail).toMatchObject({ trigger: "pending_transfer" });
    expect(handoffs[0]?.detail).toHaveProperty("reference");
  });
});

// --- The attacks -------------------------------------------------------------

describe("the attacks", () => {
  it("ignores a tampered amount and account number in the returned payload", async () => {
    const token = await askToSend();
    await open(token);

    // The published prior-art Flow echoes `amount`, `account_number`, `bank` and
    // `recipient_name` back from the screen the server rendered. This is that
    // payload: the Customer approved ₦2,000 to CHIDI EZE and the handset is
    // asking for ₦900,000 to somebody else, with a correct PIN.
    const done = await submit(token, {
      pin: PIN,
      amount: 900_000,
      account_number: "9999999999",
      bank: "Some Other Bank",
      recipient_name: "FRAUDSTER LTD",
    });

    expect(done.screen).toBe("DONE");
    expect(transferSent()).toMatchObject({
      toAccountNumber: DESTINATION,
      amount: AMOUNT,
    });
    expect(harness.bankOne.transfers).toHaveLength(1);
  });

  it("refuses to authorise the same Mandate twice", async () => {
    const token = await askToSend();

    expect((await submit(token, { pin: PIN })).screen).toBe("DONE");

    const again = await submit(token, { pin: PIN });
    expect(again.screen).toBe("UNAVAILABLE");
    // One authorisation, one debit.
    expect(harness.bankOne.transfers).toHaveLength(1);
  });

  it("expires a Mandate after three hours and tells the Customer to start again", async () => {
    const token = await askToSend();

    harness.clock.advance(3 * 60 * 60 * 1000 + 1000);

    const done = await submit(token, { pin: PIN });
    expect(done.screen).toBe("UNAVAILABLE");
    expect(done.data["message"]).toContain("start again");
    expect(harness.bankOne.transfers).toEqual([]);
  });

  it("never debits twice when a dispatch is lost in flight", async () => {
    // BankOne performed the transfer and the response never arrived. A caller
    // that reads that as a failure and sends it again has just debited the
    // Customer twice — BankOne guarantees no idempotency on the reference.
    await start({ transfer: { dispatch: "drops", settles: "succeeded" } });

    const done = await submit(await askToSend(), { pin: PIN });

    expect(harness.bankOne.transfers).toHaveLength(1);
    // The status query on the same reference is how the platform found out.
    expect(harness.bankOne.statusQueries).toContain(harness.bankOne.transfers[0]?.reference);
    expect(done.data["message"]).toContain("Sent ₦2,000 to CHIDI EZE");
  });

  it("refuses a transfer whose Binding was revoked while it waited", async () => {
    // The stolen-handset window. A proposal lives for three hours, and a
    // Customer who reports a stolen phone has their Binding revoked in the
    // middle of one — so a Mandate that outlived its Binding would hold open
    // exactly the window the revocation exists to close, on the one path that
    // moves money.
    const token = await askToSend();
    await harness.revokeBindingsFor(CUSTOMER);

    const refused = await submit(token, { pin: PIN });

    expect(refused.screen).toBe("UNAVAILABLE");
    expect(harness.bankOne.transfers).toEqual([]);
  });

  it("locks the Customer out after three wrong PINs, across transfers", async () => {
    const first = await askToSend();
    expect((await submit(first, { pin: "0000" })).data["error_message"]).toContain("2 attempts left");
    expect((await submit(first, { pin: "0000" })).data["error_message"]).toContain("1 attempt left");

    // A fresh transfer, and the counter is the **Customer's** rather than the
    // Mandate's. Otherwise starting again buys three more guesses at four
    // digits, and guessing is free.
    const second = await askToSend();
    const locked = await submit(second, { pin: "0000" });

    expect(locked.screen).toBe("LOCKED");
    expect(harness.bankOne.transfers).toEqual([]);

    // And the right PIN does not get in during the hour.
    expect((await submit(second, { pin: PIN })).screen).toBe("LOCKED");
    expect(harness.bankOne.transfers).toEqual([]);
  });
});

// --- What the platform will not do ------------------------------------------

describe("what is refused before a Mandate exists", () => {
  it("declines an account number nobody holds, and says which part to check", async () => {
    saysTransfer(AMOUNT, "2200112230");
    const replies = await say("send 2000 to 2200112230");

    expect(replies.at(-1)).toContain("could not find that account");
    expect(harness.bankOne.transfers).toEqual([]);
  });

  it("declines a bank it cannot place rather than sending it down this endpoint", async () => {
    // Routing is decided from the bank code alone, and a bank that resolves to
    // no code has none. Sending this anyway would reach whoever holds that
    // number at *this* Bank — the failure mode a guess costs a Customer their
    // money for — so it is refused before name enquiry is even asked.
    saysTransfer(AMOUNT, DESTINATION, "Zenit Bnk");
    const replies = await say("send 2000 to 2124955312 at Zenit Bnk");

    expect(replies.at(-1)).toContain("I do not recognise that bank");
    expect(harness.bankOne.transfers).toEqual([]);
    expect(
      harness.bankOne.requests.filter((request) => request.path.endsWith("/NameEnquiry")),
    ).toEqual([]);
  });

  it("treats a bank the Customer did not name as their own", async () => {
    // "send 2000 to 2124955312" is how most Customers say it. The model is told
    // to leave the field empty rather than invent a bank, and an empty field
    // means their own — with the destination bank and the account's name on the
    // Confirmation screen either way.
    const confirm = await open(await askToSend(AMOUNT, DESTINATION, ""));

    expect(confirm.screen).toBe("CONFIRM");
    expect(confirm.data["destination_bank"]).toBe(BANK_NAME);
  });
});

// --- The audit trail ---------------------------------------------------------

describe("what the Bank can reconstruct afterwards", () => {
  it("records what was proposed, that it was authorised, and what BankOne said", async () => {
    await submit(await askToSend(), { pin: PIN });

    const proposed = (await auditRows("transfer.proposed"))[0];
    const settled = (await auditRows("mandate.settled"))[0];

    expect(proposed?.detail).toMatchObject({
      destinationAccount: DESTINATION,
      amount: AMOUNT,
    });
    expect(await auditRows("mandate.authorised")).toHaveLength(1);
    expect(settled?.detail).toMatchObject({ result: "succeeded" });
    // One reference ties the proposal, the authorisation and BankOne's own
    // record of the transfer together.
    expect(settled?.detail["reference"]).toBe(proposed?.detail["reference"]);
  });

  it("does not call an unauthorised transfer a Mandate", async () => {
    // The row written before the PIN says `transfer.proposed`, because a Mandate
    // is an instruction the Customer has authorised. An investigator reading
    // "mandate" in this table is reading about money somebody approved.
    await open(await askToSend());

    expect(await auditRows("transfer.proposed")).toHaveLength(1);
    expect(await auditRows("mandate.authorised")).toEqual([]);
    expect(await auditRows("mandate.dispatched")).toEqual([]);
  });
});

/**
 * The audit table, read the way the Dashboard reads it.
 *
 * Through the Middleware's own signed-in surface rather than through the
 * database, because that is the path a Support Officer has and it is the one
 * worth knowing works.
 */
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

import { afterEach, describe, expect, it } from "vitest";

import { saidPayload, type FakeTransaction } from "@avni/fakes";

import { postWebhook, startHarness, waitFor, waitForReplies, type Harness } from "./harness";

/**
 * The second read, and the honest one.
 *
 * A Customer asks what has happened on their account and is answered — except
 * that the first deployment's token is **not entitled** to `GetTransactions` and
 * `GetDailyAccountStatement` 404s on their deployment, so there is no fallback
 * to read instead (Appendix A.1, ticket 16). Both futures are driven here: the
 * one the Bank has today, and the one the entitlement brings.
 *
 * The fake is switched between them mid-journey, because that is what the Bank
 * throwing the switch will actually look like from inside this platform.
 */

const CUSTOMER = "2348012345678";
const ACCOUNT = "0123456789";

let harness: Harness;

const envelope = { phoneNumberId: "test-phone-number-id", from: CUSTOMER };

/** The harness clock starts here, so the rows below sit inside "last month". */
const SALARY: FakeTransaction = {
  amount: 1_000_000,
  direction: "credit",
  occurredAt: new Date("2026-08-19T08:00:00Z"),
  narration: "Salary August",
  reference: "sal-1",
};
const AIRTIME: FakeTransaction = {
  amount: 5_000,
  direction: "debit",
  occurredAt: new Date("2026-08-20T07:30:00Z"),
  narration: "Airtime MTN",
  reference: "air-1",
};

const start = async (options: {
  entitled: boolean;
  transactions?: readonly FakeTransaction[];
}): Promise<void> => {
  harness = await startHarness({
    accounts: [
      {
        accountNumber: ACCOUNT,
        availableBalance: 1_000_000,
        transactions: options.transactions ?? [SALARY, AIRTIME],
      },
    ],
    ...(options.entitled ? {} : { unentitled: ["GetTransactions"] }),
  });
  await harness.seedBinding(CUSTOMER, ACCOUNT);
};

afterEach(async () => {
  await harness?.stop();
});

describe("a Customer asks what has happened on their account", () => {
  it("is told, when the Bank's token carries the entitlement", async () => {
    await start({ entitled: true });

    await postWebhook(harness, saidPayload({ ...envelope, text: "what have I spent this month" }));

    const [reply] = await waitForReplies(harness);
    expect(reply).toContain("Here are your most recent transactions in the last month:");
    expect(reply).toContain("₦5,000 out · Airtime MTN");
    expect(reply).toContain("₦1,000,000 in · Salary August");
  });

  it("is shown ₦1,000,000 and never ₦1", async () => {
    // BankOne sends "1,000,000.00" in a row exactly as it does in a balance.
    // `parseFloat` on that is 1, and it fails only above ₦1,000.
    await start({ entitled: true, transactions: [SALARY] });

    await postWebhook(harness, saidPayload({ ...envelope, text: "recent transactions" }));

    const [reply] = await waitForReplies(harness);
    expect(reply).toContain("₦1,000,000 in");
    expect(reply).not.toContain("₦1 in");
  });

  it("is told nothing happened, when nothing did", async () => {
    // An empty month is an answer, and a different one from being unable to
    // look. A Customer shown a blank concludes the wrong thing either way.
    await start({ entitled: true, transactions: [] });

    await postWebhook(harness, saidPayload({ ...envelope, text: "my recent transactions" }));

    expect(await waitForReplies(harness)).toEqual([
      "Nothing has happened on your account in the last month.",
    ]);
  });

  it("is never told nothing happened on the strength of a refusal", async () => {
    // `{"IsSuccessful": false, "Transactions": []}` — a refusal with an empty
    // list beside it. Reading the list and not the flag would tell a Customer
    // their account was quiet all month, which is a lie about their money
    // rather than a broken read.
    await start({ entitled: true });
    harness.bankOne.setDeclaredFailure("GetTransactions", "Unable to retrieve transactions");

    await postWebhook(harness, saidPayload({ ...envelope, text: "transaction history" }));

    const [reply] = await waitForReplies(harness);
    expect(reply).not.toMatch(/nothing has happened/i);
    expect(reply).toContain("Something went wrong");
  });

  it("is asked for no Transaction PIN, because a read is silent", async () => {
    await start({ entitled: true });

    await postWebhook(harness, saidPayload({ ...envelope, text: "transaction history" }));
    await waitForReplies(harness);

    // No sealed surface, no Flow, no Mandate — words, and nothing else.
    expect(harness.whatsapp.sent.every((message) => message.type === "text")).toBe(true);
  });

  it("has their account resolved by the Middleware, never named by the Platform", async () => {
    await start({ entitled: true });

    await postWebhook(harness, saidPayload({ ...envelope, text: "transaction history" }));
    await waitForReplies(harness);

    // The Intent carries the period and nothing else. The account BankOne was
    // asked about came from the Binding, and the model never saw it.
    expect(harness.bankOne.requests[0]?.query["accountNumber"]).toBe(ACCOUNT);
    for (const call of harness.groq.calls) expect(call.prompt).not.toContain(ACCOUNT);
  });

  it("is answered the same whichever way BankOne spells its rows", async () => {
    // The response shape is unverified — the specification says "e.g." beside
    // every field name — so the reply must not depend on which one arrives.
    await start({ entitled: true });
    harness.bankOne.setTransactionDialect("alternate");

    await postWebhook(harness, saidPayload({ ...envelope, text: "transaction history" }));

    const [reply] = await waitForReplies(harness);
    expect(reply).toContain("₦5,000 out · Airtime MTN");
    expect(reply).toContain("₦1,000,000 in · Salary August");
  });
});

describe("the same Customer, on the token the Bank actually has", () => {
  it("is told plainly that history is unavailable", async () => {
    await start({ entitled: false });

    await postWebhook(harness, saidPayload({ ...envelope, text: "transaction history" }));

    const [reply] = await waitForReplies(harness);
    expect(reply).toContain("cannot show your transaction history");
  });

  it("is shown neither an error nor an empty list", async () => {
    // The two wrong answers. One says the platform is broken; the other says
    // nothing happened on the account, which is a lie about their money.
    await start({ entitled: false });

    await postWebhook(harness, saidPayload({ ...envelope, text: "transaction history" }));

    const [reply] = await waitForReplies(harness);
    expect(reply).not.toMatch(/error|failed|exception|went wrong/i);
    expect(reply).not.toMatch(/nothing has happened/i);
  });

  it("is told nothing about BankOne, tokens or entitlements", async () => {
    await start({ entitled: false });

    await postWebhook(harness, saidPayload({ ...envelope, text: "transaction history" }));

    const [reply] = await waitForReplies(harness);
    expect(reply).not.toMatch(/BankOne|HTTP|authtoken|institution|entitle/i);
  });

  it("starts being answered the moment the Bank throws the switch", async () => {
    // The whole point of shipping this now: the day ticket 16 lands, nothing
    // here is rewritten.
    await start({ entitled: false });

    await postWebhook(harness, saidPayload({ ...envelope, text: "transaction history" }));
    const [before] = await waitForReplies(harness, 1);

    // Being told *no* now hands the Customer to a human (Handoff trigger 4),
    // and **a Handoff is a transfer of ownership** — so until an Officer
    // resolves it the Agent is not answering this Customer at all. That is the
    // behaviour, and it is why this journey closes the conversation before
    // asking again rather than pretending the Agent was still there.
    await harness.resolveHandoffs();

    harness.bankOne.setEntitled("GetTransactions", true);
    await postWebhook(harness, saidPayload({ ...envelope, text: "transaction history please" }));
    const after = await waitFor(
      () => harness.whatsapp.transcript().find((words) => words.includes("Airtime MTN")),
      "the history, once the entitlement is on",
    );

    expect(before).toContain("cannot show your transaction history");
    expect(after).toContain("₦5,000 out · Airtime MTN");
  });

  it("still answers a balance, because one entitlement is not the other", async () => {
    await start({ entitled: false });

    await postWebhook(harness, saidPayload({ ...envelope, text: "what's my balance" }));

    expect(await waitForReplies(harness)).toEqual(["Your available balance is ₦1,000,000."]);
  });
});

describe("the Intent the Platform is allowed to submit", () => {
  it("carries the period and nothing else", async () => {
    await start({ entitled: true });

    // An Intent naming an account is not a smaller request; it fails to parse,
    // and the read is never attempted.
    const conversation = await fetch(`${harness.middlewareUrl}/platform/conversations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel: "whatsapp", channelIdentity: CUSTOMER }),
    });
    const { conversationId } = (await conversation.json()) as { conversationId: string };

    const response = await fetch(
      `${harness.middlewareUrl}/platform/conversations/${conversationId}/intents`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          intent: { kind: "list_transactions", period: "last_month", accountNumber: "9999999999" },
        }),
      },
    );

    expect(response.status).toBe(400);
    expect(harness.bankOne.requests).toHaveLength(0);
  });
});

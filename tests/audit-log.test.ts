import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { saidPayload } from "@avni/fakes";

import { readAuditEntries, type AuditEntry } from "../apps/dashboard/src/audit";
import { postWebhook, startHarness, waitFor, waitForReplies, type Harness } from "./harness";

/**
 * The audit log, proved end to end rather than in shape alone: a Customer asks
 * for their balance on WhatsApp, and the Bank can afterwards reconstruct who
 * looked at what — by reading through the Middleware, exactly as the Dashboard
 * does.
 */

const CUSTOMER = "2348012345678";
const ACCOUNT = "0123456789";

let harness: Harness;
/** Somebody has to be looking. Reading the log is itself an audited act. */
let officerToken: string;

const envelope = { phoneNumberId: "test-phone-number-id", from: CUSTOMER };

/** What the Dashboard would call, signed in as a Support Officer. */
const readAudit = (
  options: Omit<Parameters<typeof readAuditEntries>[0], "token"> = {},
): Promise<readonly AuditEntry[]> =>
  readAuditEntries({ ...options, token: officerToken, middlewareBaseUrl: harness.middlewareUrl });

const waitForAction = async (action: string): Promise<AuditEntry> =>
  waitFor(async () => (await readAudit({ action })).at(0), `an audit row for ${action}`);

beforeEach(async () => {
  harness = await startHarness({
    accounts: [{ accountNumber: ACCOUNT, availableBalance: 1_000_000 }],
  });
  ({ token: officerToken } = await harness.signInStaff());
});

afterEach(async () => {
  await harness?.stop();
});

describe("a balance enquiry, afterwards", () => {
  it("leaves a row the Dashboard can read through the Middleware", async () => {
    await harness.seedBinding(CUSTOMER, ACCOUNT);

    await postWebhook(harness, saidPayload({ ...envelope, text: "what's my balance" }));
    await waitForReplies(harness);

    const entry = await waitForAction("banking.balance_read");
    expect(entry).toMatchObject({
      action: "banking.balance_read",
      actorKind: "customer",
      outcome: "succeeded",
      accountNumber: ACCOUNT,
    });
    expect(entry.conversationId).toEqual(expect.any(String));
  });

  it("records who, when, what, which account, the outcome and a correlating id", async () => {
    await harness.seedBinding(CUSTOMER, ACCOUNT);

    await postWebhook(harness, saidPayload({ ...envelope, text: "balance" }));
    await waitForReplies(harness);
    const entry = await waitForAction("banking.balance_read");

    expect(entry.actorKind).toBeTruthy();
    expect(Number.isNaN(Date.parse(entry.recordedAt))).toBe(false);
    expect(entry.action).toBeTruthy();
    expect(entry.accountNumber).toBe(ACCOUNT);
    expect(entry.outcome).toBeTruthy();
    expect(entry.conversationId).toBeTruthy();
  });

  it("does not put the balance in the row", async () => {
    // The audit table answers *who looked*. A row carrying the figure would
    // make every investigation a second copy of the Customer's finances.
    await harness.seedBinding(CUSTOMER, ACCOUNT);

    await postWebhook(harness, saidPayload({ ...envelope, text: "balance" }));
    await waitForReplies(harness);
    await waitForAction("banking.balance_read");

    expect(JSON.stringify(await readAudit())).not.toContain("1000000");
  });

  it("reconstructs the whole conversation from one id", async () => {
    await harness.seedBinding(CUSTOMER, ACCOUNT);

    await postWebhook(harness, saidPayload({ ...envelope, text: "balance" }));
    await waitForReplies(harness);
    const read = await waitForAction("banking.balance_read");

    const conversation = await readAudit({ conversationId: read.conversationId ?? "" });

    expect(conversation.map((entry) => entry.action)).toEqual([
      "banking.balance_read",
      "conversation.opened",
    ]);
  });

  it("narrows to one Customer, which is the insider-threat question", async () => {
    await harness.seedBinding(CUSTOMER, ACCOUNT);

    await postWebhook(harness, saidPayload({ ...envelope, text: "balance" }));
    await waitForReplies(harness);
    await waitForAction("banking.balance_read");

    const mine = await readAudit({ accountNumber: ACCOUNT });
    const someoneElse = await readAudit({ accountNumber: "9999999999" });

    expect(mine.length).toBeGreaterThan(0);
    expect(someoneElse).toEqual([]);
  });
});

describe("what else gets recorded", () => {
  it("records a Binding being created", async () => {
    await harness.seedBinding(CUSTOMER, ACCOUNT);

    expect(await waitForAction("binding.created")).toMatchObject({
      actorKind: "system",
      outcome: "succeeded",
      accountNumber: ACCOUNT,
    });
  });

  it("records the auto-revoke when an account moves to a new number", async () => {
    // The row a Customer reporting a takeover they did not perform is
    // reconstructed from.
    await harness.seedBinding(CUSTOMER, ACCOUNT);
    await harness.seedBinding("2348055555555", ACCOUNT);

    const revoked = await waitForAction("binding.revoked");
    expect(revoked).toMatchObject({ outcome: "succeeded", accountNumber: ACCOUNT });
    expect(String(revoked.detail["reason"])).toContain("another channel identity");
  });

  it("records a request that could not be identified", async () => {
    // What an investigation into probing wants to see.
    //
    // **No Intent is submitted for a number with no Binding** — the Platform
    // greets a stranger rather than putting their words through a model, so
    // there is no `intent.submitted` row to find and inventing one would be
    // recording something that did not happen. What the investigation gets
    // instead is the conversation itself, opened and marked unidentified, with
    // the words the stranger sent recorded against it.
    await postWebhook(
      harness,
      saidPayload({ phoneNumberId: "test-phone-number-id", from: "2348099999999", text: "balance" }),
    );
    await waitForReplies(harness);

    const entry = await waitForAction("conversation.opened");
    expect(entry).toMatchObject({ outcome: "succeeded", accountNumber: null });
    expect(entry.detail["identified"]).toBe(false);
    expect(entry.detail["channel"]).toBe("whatsapp");
  });

  it("records transaction history as unavailable rather than failed", async () => {
    // The first deployment's token, as it is today. Nobody should be paged for an
    // entitlement nobody has asked the Bank for yet.
    await harness.seedBinding(CUSTOMER, ACCOUNT);
    harness.bankOne.setEntitled("GetTransactions", false);
    harness.groq.setResolver(() => ({ kind: "list_transactions", period: "last_month" }));

    await postWebhook(harness, saidPayload({ ...envelope, text: "what happened last month" }));
    await waitForReplies(harness);

    expect(await waitForAction("banking.transactions_read")).toMatchObject({
      outcome: "unavailable",
      accountNumber: ACCOUNT,
    });
  });

  it("records a read that failed, with BankOne's reason kept out of the Customer's reply", async () => {
    await harness.seedBinding(CUSTOMER, "1111111111");

    await postWebhook(harness, saidPayload({ ...envelope, text: "balance" }));
    const [reply] = await waitForReplies(harness);

    const entry = await waitForAction("banking.balance_read");
    expect(entry.outcome).toBe("failed");
    expect(entry.detail["reason"]).toBeTruthy();
    // The reason is in the table, where a Support Officer can reach it — and
    // not in what the Customer was told.
    expect(reply).not.toContain(String(entry.detail["reason"]));
  });
});

describe("the log as evidence", () => {
  it("keeps every row, in order, across many events", async () => {
    await harness.seedBinding(CUSTOMER, ACCOUNT);

    for (let index = 0; index < 3; index += 1) {
      await postWebhook(harness, saidPayload({ ...envelope, text: "balance" }));
      await waitForReplies(harness, index + 1);
    }
    await waitFor(
      async () => ((await readAudit({ action: "banking.balance_read" })).length >= 3 ? true : undefined),
      "three balance reads",
    );

    const entries = await readAudit();
    const ids = entries.map((entry) => Number(entry.id));
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
  });

  it("stays newest-first once the table passes nine rows", async () => {
    // **The boundary this crosses is the whole test.** `id` is a `bigserial`,
    // and it is also selected as `id::text` — so a bare `order by id` bound to
    // the *output* column and sorted the Bank's security record lexically.
    // Every row up to the ninth reads correctly, and then `"9"` sits above
    // `"10"` for the rest of the deployment's life, which is exactly the shape
    // of a bug nobody notices in a test suite and everybody notices in an
    // investigation.
    await harness.seedBinding(CUSTOMER, ACCOUNT);
    for (let index = 0; index < 12; index += 1) {
      await postWebhook(harness, saidPayload({ ...envelope, text: "balance" }));
      await waitForReplies(harness, index + 1);
    }
    await waitFor(
      async () =>
        (await readAudit({ action: "banking.balance_read", limit: 500 })).length >= 12
          ? true
          : undefined,
      "twelve balance reads",
    );

    const ids = (await readAudit({ limit: 500 })).map((entry) => Number(entry.id));

    expect(ids.length).toBeGreaterThan(9);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    // And the newest really is the newest, rather than whichever id happens to
    // start with the largest digit.
    expect(ids[0]).toBe(Math.max(...ids));
  });

  it("survives the Platform never having touched it", async () => {
    // The Platform has no route to this table and no credential for it. Every
    // row above was written by the Middleware.
    await harness.seedBinding(CUSTOMER, ACCOUNT);
    await waitForAction("binding.created");

    const response = await fetch(`${harness.platformUrl}/dashboard/audit`);
    expect(response.status).toBe(404);
  });

  it("cannot be read without signing in", async () => {
    const response = await fetch(`${harness.middlewareUrl}/dashboard/audit`);

    expect(response.status).toBe(401);
  });

  it("records the reading of it, because looking is the sensitive act", async () => {
    await harness.seedBinding(CUSTOMER, ACCOUNT);
    await waitForAction("binding.created");

    await readAudit({ accountNumber: ACCOUNT });
    const reads = await readAudit({ action: "audit.read" });

    // Newest first — and the newest is *this* query, because reading the log
    // is recorded too. The row being looked for is the one before it.
    expect(reads[0]).toMatchObject({ actorKind: "officer", outcome: "succeeded" });
    const forThisCustomer = reads.find(
      (entry) => (entry.detail["filters"] as Record<string, unknown>)["accountNumber"] === ACCOUNT,
    );
    expect(forThisCustomer).toBeDefined();
  });
});

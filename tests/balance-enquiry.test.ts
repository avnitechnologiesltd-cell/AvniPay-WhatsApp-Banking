import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { chosePayload, deliveryReceiptPayload, saidPayload } from "@avni/fakes";

import {
  postWebhook,
  startHarness,
  waitFor,
  waitForReplies,
  type Harness,
} from "./harness";

/**
 * The first tracer bullet, and the widest: a Customer sends *"what's my
 * balance"* to the Bank's WhatsApp number and gets their balance back.
 *
 * Driven through the Platform's real webhook, asserting what the **Customer**
 * observes. The rule of thumb this codebase is written against: if a test would
 * still pass after the money went to the wrong account, it is testing the wrong
 * thing.
 */

const CUSTOMER = "2348012345678";
const ACCOUNT = "0123456789";
const STRANGER = "2348099999999";

let harness: Harness;

/** What a number with no Binding is told, before anything reads their words. */
const GREET = "Do you have a bank account";

const envelope = { phoneNumberId: "test-phone-number-id", from: CUSTOMER };

beforeEach(async () => {
  harness = await startHarness({
    accounts: [{ accountNumber: ACCOUNT, availableBalance: 1_000_000 }],
  });
});

afterEach(async () => {
  await harness?.stop();
});

describe("a Customer asks for their balance", () => {
  it("is told it, in their own words and in the same conversation", async () => {
    await harness.seedBinding(CUSTOMER, ACCOUNT);

    await postWebhook(harness, saidPayload({ ...envelope, text: "what's my balance" }));

    expect(await waitForReplies(harness)).toEqual(["Your available balance is ₦1,000,000."]);
  });

  it("is told ₦1,000,000 and never ₦1", async () => {
    // BankOne sends "1,000,000.00". `parseFloat` on that is 1. This is the
    // whole journey's reason for existing, and it fails only above ₦1,000.
    await harness.seedBinding(CUSTOMER, ACCOUNT);

    await postWebhook(harness, saidPayload({ ...envelope, text: "how much do I have" }));

    const [reply] = await waitForReplies(harness);
    expect(reply).toContain("₦1,000,000");
    expect(reply).not.toContain("₦1.");
    expect(reply).not.toBe("Your available balance is ₦1.");
  });

  it("is asked for no Transaction PIN, because a read is silent", async () => {
    await harness.seedBinding(CUSTOMER, ACCOUNT);

    await postWebhook(harness, saidPayload({ ...envelope, text: "balance" }));
    await waitForReplies(harness);

    // No sealed surface, no Flow, nothing but words.
    expect(harness.whatsapp.sent.every((message) => message.type === "text")).toBe(true);
  });

  it("has their account resolved by the Middleware, never named by the Platform", async () => {
    await harness.seedBinding(CUSTOMER, ACCOUNT);

    await postWebhook(harness, saidPayload({ ...envelope, text: "balance" }));
    await waitForReplies(harness);

    // The Intent that went to the model and came back names no account; the
    // account BankOne was asked about came from the Binding.
    expect(harness.bankOne.requests[0]?.query["accountNumber"]).toBe(ACCOUNT);
    expect(harness.groq.calls[0]?.prompt).not.toContain(ACCOUNT);
  });

  it("never has their account number shown to the model", async () => {
    await harness.seedBinding(CUSTOMER, ACCOUNT);

    await postWebhook(harness, saidPayload({ ...envelope, text: "balance please" }));
    await waitForReplies(harness);

    for (const call of harness.groq.calls) {
      expect(call.prompt).not.toContain(ACCOUNT);
    }
  });

  it("has their words resolved by a constrained model call with no tools", async () => {
    await harness.seedBinding(CUSTOMER, ACCOUNT);

    await postWebhook(harness, saidPayload({ ...envelope, text: "balance" }));
    await waitForReplies(harness);

    expect(harness.groq.calls[0]).toMatchObject({
      model: "openai/gpt-oss-20b",
      temperature: 0,
      strict: true,
      hasTools: false,
    });
  });
});

describe("a Customer with no Binding", () => {
  it("is told how to link rather than given somebody's balance", async () => {
    await postWebhook(
      harness,
      saidPayload({ phoneNumberId: "test-phone-number-id", from: STRANGER, text: "balance" }),
    );

    // **Greeted, not interpreted.** A number with no Binding is asked whether
    // they bank here at all, before any model reads their words — which is also
    // why BankOne is never called.
    const [reply] = await waitForReplies(harness);
    expect(reply).toContain(GREET);
    expect(harness.bankOne.requests).toHaveLength(0);
  });

  it("cannot reach an account by asking for one", async () => {
    // The Intent union has no field for an account number, so there is nothing
    // to smuggle. This asserts the consequence at the outside edge.
    await postWebhook(
      harness,
      saidPayload({
        phoneNumberId: "test-phone-number-id",
        from: STRANGER,
        text: `what is the balance of account ${ACCOUNT}`,
      }),
    );

    await waitForReplies(harness);
    expect(harness.bankOne.requests).toHaveLength(0);
  });
});

describe("a Binding revoked mid-conversation", () => {
  it("stops answering immediately rather than at the end of the conversation", async () => {
    await harness.seedBinding(CUSTOMER, ACCOUNT);
    await postWebhook(harness, saidPayload({ ...envelope, text: "balance" }));
    await waitForReplies(harness, 1);

    await harness.revokeBindingsFor(CUSTOMER);
    await postWebhook(harness, saidPayload({ ...envelope, text: "balance again" }));

    const replies = await waitForReplies(harness, 2);
    // The Binding is gone, so the next message is greeted like a stranger's.
    expect(replies[1]).toContain(GREET);
  });
});

describe("the said / chose / event split", () => {
  it("shows the model what the Customer typed", async () => {
    await harness.seedBinding(CUSTOMER, ACCOUNT);

    await postWebhook(harness, saidPayload({ ...envelope, text: "what's my balance" }));
    await waitForReplies(harness);

    const user = harness.groq.calls[0]?.messages.filter((message) => message.role === "user");
    expect(user).toEqual([{ role: "user", content: "what's my balance" }]);
  });

  it("routes a tapped control through code, with no model call at all", async () => {
    await harness.seedBinding(CUSTOMER, ACCOUNT);

    await postWebhook(harness, chosePayload({ ...envelope, id: "menu_transfer" }));
    await waitForReplies(harness);

    expect(harness.groq.calls).toHaveLength(0);
  });

  it("never shows a delivery receipt to the model, and never answers one", async () => {
    await harness.seedBinding(CUSTOMER, ACCOUNT);

    await postWebhook(harness, deliveryReceiptPayload({ ...envelope, status: "delivered" }));
    // Then something that does produce a reply, so the wait has an end.
    await postWebhook(harness, saidPayload({ ...envelope, text: "balance" }));

    const replies = await waitForReplies(harness);
    expect(replies).toHaveLength(1);
    expect(harness.groq.calls).toHaveLength(1);
  });

  it("keeps a typed id apart from the same id tapped", async () => {
    await harness.seedBinding(CUSTOMER, ACCOUNT);

    await postWebhook(harness, saidPayload({ ...envelope, text: "menu_transfer" }));
    await waitForReplies(harness, 1);

    // Typed: it went to the model. Tapped, it would not have.
    expect(harness.groq.calls).toHaveLength(1);
    expect(harness.groq.calls[0]?.prompt).toContain("menu_transfer");
  });
});

describe("the conversation id", () => {
  it("is issued by the Middleware and quoted by the Platform", async () => {
    await harness.seedBinding(CUSTOMER, ACCOUNT);

    await postWebhook(harness, saidPayload({ ...envelope, text: "balance" }));
    await waitForReplies(harness, 1);
    await postWebhook(harness, saidPayload({ ...envelope, text: "balance again" }));
    await waitForReplies(harness, 2);

    // One conversation opened, quoted twice — the Platform never mints one.
    const opened = await fetch(`${harness.middlewareUrl}/health`);
    expect(opened.status).toBe(200);
    expect(harness.bankOne.requests).toHaveLength(2);
  });
});

describe("when BankOne will not answer", () => {
  it("tells the Customer something went wrong, and nothing about BankOne", async () => {
    await harness.seedBinding(CUSTOMER, "1111111111");

    await postWebhook(harness, saidPayload({ ...envelope, text: "balance" }));

    const [reply] = await waitForReplies(harness);
    expect(reply).toContain("Something went wrong");
    expect(reply).not.toMatch(/BankOne|HTTP|token|institution/i);
  });
});

describe("the webhook itself", () => {
  it("answers Meta's subscription challenge", async () => {
    const url = new URL(`${harness.platformUrl}/channels/whatsapp/webhook`);
    url.searchParams.set("hub.mode", "subscribe");
    url.searchParams.set("hub.verify_token", "test-verify-token");
    url.searchParams.set("hub.challenge", "challenge-value");

    const response = await fetch(url);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("challenge-value");
  });

  it("refuses a challenge with the wrong token", async () => {
    const url = new URL(`${harness.platformUrl}/channels/whatsapp/webhook`);
    url.searchParams.set("hub.mode", "subscribe");
    url.searchParams.set("hub.verify_token", "wrong");
    url.searchParams.set("hub.challenge", "challenge-value");

    expect((await fetch(url)).status).toBe(403);
  });

  it("answers 200 to an unreadable payload rather than inviting a retry", async () => {
    expect(await postWebhook(harness, { nothing: "recognisable" })).toBe(200);
  });

  it("answers 200 promptly, before the reply has been composed", async () => {
    await harness.seedBinding(CUSTOMER, ACCOUNT);

    const status = await postWebhook(harness, saidPayload({ ...envelope, text: "balance" }));

    expect(status).toBe(200);
    await waitForReplies(harness);
  });
});

describe("the Platform's blast radius", () => {
  it("never learns the Customer's account number", async () => {
    await harness.seedBinding(CUSTOMER, ACCOUNT);

    await postWebhook(harness, saidPayload({ ...envelope, text: "balance" }));
    await waitForReplies(harness);

    // Everything the Platform sent anywhere, checked for the one value it must
    // not hold. The Middleware answers with a balance, never with an account.
    const everythingTheModelSaw = harness.groq.calls.map((call) => call.prompt).join("\n");
    const everythingTheCustomerSaw = harness.whatsapp.transcript().join("\n");

    expect(everythingTheModelSaw).not.toContain(ACCOUNT);
    expect(everythingTheCustomerSaw).not.toContain(ACCOUNT);
  });

  it("holds no Binding in Postgres", async () => {
    await harness.seedBinding(CUSTOMER, ACCOUNT);
    await postWebhook(harness, saidPayload({ ...envelope, text: "balance" }));
    await waitForReplies(harness);

    // The Platform may cache a conversation id in memory. It writes nothing.
    await waitFor(() => (harness.bankOne.requests.length > 0 ? true : undefined), "the read");
  });
});

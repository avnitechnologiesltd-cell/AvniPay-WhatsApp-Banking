import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  saidPayload,
  signInAppIdentity,
  stripSignature,
  tamperWithAccountNumber,
  type FakeTransaction,
} from "@avni/fakes";
import { CONTRACT_VERSIONS } from "@avni/middleware";

import {
  PLATFORM_PUBLIC_BASE_URL,
  exchangeInApp,
  openInApp,
  postWebhook,
  startHarness,
  waitForReplies,
  type Harness,
  type IssuedSnippet,
} from "./harness";

/**
 * The second **Channel**: a Customer already signed in to the Bank's own mobile
 * application opens chat and reads their money.
 *
 * Driven the way the Widget drives it — through the Platform's versioned edge,
 * carrying an envelope the Bank's backend signed and nothing else. The tests
 * that matter most here are the refusals: reads are silent, taking no
 * Transaction PIN and building no Mandate, so a Channel that trusted the number
 * it was handed would hand any Customer's balance and full history to anyone
 * who edited one field.
 */

const ACCOUNT = "0123456789";
const STRANGER = "9876543210";
const WHATSAPP_NUMBER = "2348012345678";

/** The harness clock starts here, so these sit inside "last month". */
const SALARY: FakeTransaction = {
  amount: 1_000_000,
  direction: "credit",
  occurredAt: new Date("2026-08-19T08:00:00Z"),
  narration: "Salary August",
  reference: "sal-1",
};

let harness: Harness;
let snippet: IssuedSnippet;

const start = async (options: { entitled?: boolean } = {}): Promise<void> => {
  harness = await startHarness({
    accounts: [
      { accountNumber: ACCOUNT, availableBalance: 1_000_000, transactions: [SALARY] },
      { accountNumber: STRANGER, availableBalance: 42 },
    ],
    ...(options.entitled ? {} : { unentitled: ["GetTransactions"] }),
  });
  snippet = await harness.generateSnippet();
};

/** An envelope for `account`, signed by the Bank's backend, good for an hour. */
const identityFor = (account = ACCOUNT, secret = snippet.secret): string =>
  signInAppIdentity(secret, {
    accountNumber: account,
    expiresAt: new Date(harness.clock.now().getTime() + 60 * 60 * 1000),
  });

/** Opens a conversation and insists it worked, for the journeys that assume one. */
const signedIn = async (account = ACCOUNT): Promise<string> => {
  const opened = await openInApp(harness, identityFor(account));
  if (!opened.conversationId) throw new Error(`The Customer was refused: ${opened.outcome}`);
  return opened.conversationId;
};

afterEach(async () => {
  await harness?.stop();
});

describe("an Administrator generates the Snippet", () => {
  beforeEach(async () => {
    await start();
  });

  it("gets four lines to paste and a secret shown once", () => {
    expect(snippet.secret).not.toHaveLength(0);
    expect(snippet.snippet).toContain(PLATFORM_PUBLIC_BASE_URL);
    expect(snippet.snippet).toContain("SIGNED_IDENTITY_FROM_YOUR_BACKEND");
    expect(snippet.contractVersion).toBe("v1");
  });

  it("cannot read the secret back afterwards, and nor can anybody", async () => {
    // Write-only, the same rule Connector credentials are held to. A surface
    // that can read a secret back is a surface somebody can exfiltrate one
    // through — including the Administrator who typed it.
    const { token } = await harness.signInStaff("administrator");
    const response = await fetch(`${harness.middlewareUrl}/dashboard/snippet`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).not.toContain(snippet.secret);
    expect(JSON.parse(body)).toMatchObject({ current: { contractVersion: "v1" } });
  });

  it("can still reproduce the Snippet of every version out on handsets", async () => {
    // A Snippet inside a shipped mobile application cannot be recalled, so once
    // v2 exists there are still handsets running v1 — and a Bank's engineer
    // debugging one needs to read back the exact four lines they pasted.
    const { token } = await harness.signInStaff("administrator");
    const response = await fetch(`${harness.middlewareUrl}/dashboard/snippet`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const { versions } = (await response.json()) as {
      versions: { contractVersion: string; snippet: string; signingInstructions: string[] }[];
    };

    expect(versions.map((one) => one.contractVersion)).toEqual([...CONTRACT_VERSIONS]);
    for (const one of versions) {
      // The loader builds its own URL at runtime, so what is pinned in the
      // source is the version it will ask for.
      expect(one.snippet).toContain(`var v = "${one.contractVersion}"`);
      expect(one.signingInstructions.join("\n")).toContain(`"${one.contractVersion}." + payload`);
    }
  });

  it("is not something a Support Officer may do", async () => {
    const { token } = await harness.signInStaff("support_officer");
    const response = await fetch(`${harness.middlewareUrl}/dashboard/snippet`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(403);
  });

  it("records who generated it, and that an Officer was refused", async () => {
    const { token } = await harness.signInStaff("administrator");
    const officer = await harness.signInStaff("support_officer");
    await fetch(`${harness.middlewareUrl}/dashboard/snippet`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${officer.token}` },
      body: JSON.stringify({}),
    });

    const audit = await fetch(
      `${harness.middlewareUrl}/dashboard/audit?action=snippet.issued`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    const { entries } = (await audit.json()) as {
      entries: { outcome: string; actorKind: string; detail: Record<string, unknown> }[];
    };

    expect(entries.map((entry) => entry.outcome)).toEqual(
      expect.arrayContaining(["succeeded", "refused"]),
    );
    // The secret is nowhere in the row that records issuing it.
    expect(JSON.stringify(entries)).not.toContain(snippet.secret);
  });
});

describe("a Customer already signed in to the Bank's app", () => {
  beforeEach(async () => {
    await start();
  });

  it("opens chat and is identified with no enrollment and no code", async () => {
    const opened = await openInApp(harness, identityFor());

    expect(opened.outcome).toBe("opened");
    expect(opened.conversationId).toBeDefined();
    // Nothing was sent to anybody. No OTP, no notification, no Flow.
    expect(harness.bankIdentity.codesSent).toHaveLength(0);
    expect(harness.whatsapp.sent).toHaveLength(0);
  });

  it("asks for their balance in their own words and gets it", async () => {
    const conversationId = await signedIn();

    const { reply } = await exchangeInApp(harness, { conversationId, said: "what's my balance" });

    expect(reply).toEqual({ verb: "say", text: "Your available balance is ₦1,000,000." });
  });

  it("is told plainly when transaction history is not available", async () => {
    const conversationId = await signedIn();

    const { reply } = await exchangeInApp(harness, {
      conversationId,
      said: "show me my recent transactions",
    });

    expect(reply?.["text"]).toContain("cannot show your transaction history");
  });

  it("reads their transaction history once the entitlement is there", async () => {
    await harness.stop();
    await start({ entitled: true });
    const conversationId = await signedIn();

    const { reply } = await exchangeInApp(harness, {
      conversationId,
      said: "show me my recent transactions",
    });

    expect(reply?.["text"]).toContain("Salary August");
  });

  it("is asked for no Transaction PIN, because a read is silent on both Channels", async () => {
    const conversationId = await signedIn();

    const { reply } = await exchangeInApp(harness, { conversationId, said: "balance" });

    expect(reply?.["verb"]).toBe("say");
  });

  it("leaves no Binding behind", async () => {
    const conversationId = await signedIn();
    await exchangeInApp(harness, { conversationId, said: "balance" });

    // The Bank's application states who the Customer is every time, so there
    // is nothing to remember (ADR-0010). Unlinking has nothing to destroy.
    const unlink = await fetch(
      `${harness.middlewareUrl}/platform/conversations/${conversationId}/unlink`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );

    expect(await unlink.json()).toEqual({ outcome: "not_linked" });
  });

  it("is offered no enrollment on this Channel", async () => {
    const conversationId = await signedIn();

    const surface = await fetch(
      `${harness.middlewareUrl}/platform/conversations/${conversationId}/surface`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ want: "link" }),
      },
    );

    expect(await surface.json()).toMatchObject({ outcome: "not_applicable" });
  });
});

describe("the account number does not travel as a plain value", () => {
  beforeEach(async () => {
    await start();
  });

  it("refuses an edited account number", async () => {
    // The whole reason this Channel signs anything. Reads are silent, so a
    // Snippet that trusted the number it was handed is an endpoint that returns
    // a stranger's balance and full history to whoever edits one field.
    const edited = tamperWithAccountNumber(identityFor(), STRANGER);

    expect(await openInApp(harness, edited)).toMatchObject({ outcome: "refused" });
  });

  it("refuses an expired envelope", async () => {
    const conversationId = identityFor();
    harness.clock.advance(2 * 60 * 60 * 1000);

    expect(await openInApp(harness, conversationId)).toMatchObject({ outcome: "refused" });
  });

  it("refuses an unsigned envelope", async () => {
    expect(await openInApp(harness, stripSignature(identityFor()))).toMatchObject({
      outcome: "refused",
    });
  });

  it("refuses one signed with a secret the Bank invented", async () => {
    expect(
      await openInApp(harness, identityFor(ACCOUNT, "a-secret-nobody-issued")),
    ).toMatchObject({ outcome: "refused" });
  });

  it("refuses one signed with a retired secret, on the next message", async () => {
    const retired = identityFor();
    const { token } = await harness.signInStaff("administrator");

    await fetch(
      `${harness.middlewareUrl}/dashboard/snippet/secrets/${snippet.secretId}/revoke`,
      { method: "POST", headers: { authorization: `Bearer ${token}` } },
    );

    expect(await openInApp(harness, retired)).toMatchObject({ outcome: "refused" });
  });

  it("keeps a second secret working while the first is still live", async () => {
    // The rotation window. Issuing a new secret must not break the one the
    // Bank's backend is still signing with, or nobody performs the rotation.
    const rotated = await harness.generateSnippet();

    expect(await openInApp(harness, identityFor(ACCOUNT, snippet.secret))).toMatchObject({
      outcome: "opened",
    });
    expect(await openInApp(harness, identityFor(ACCOUNT, rotated.secret))).toMatchObject({
      outcome: "opened",
    });
  });

  it("tells the Platform nothing about why, and the Middleware everything", async () => {
    await openInApp(harness, stripSignature(identityFor()));
    const { token } = await harness.signInStaff("administrator");

    const audit = await fetch(
      `${harness.middlewareUrl}/dashboard/audit?action=conversation.opened`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    const { entries } = (await audit.json()) as {
      entries: { outcome: string; detail: Record<string, unknown> }[];
    };
    const refusal = entries.find((entry) => entry.outcome === "refused");

    expect(refusal?.detail).toMatchObject({ channel: "in_app_chat", reason: "unsigned" });
  });

  it("never lets the Platform see the signing secret", async () => {
    // ADR-0006, structurally: the Platform forwards one opaque string and the
    // Middleware holds the only thing that can check it. Nothing the Platform
    // was ever configured with could verify an envelope.
    const opened = await openInApp(harness, identityFor());
    expect(opened.outcome).toBe("opened");

    const health = await fetch(`${harness.platformUrl}/health`);
    expect(await health.text()).not.toContain(snippet.secret);
  });
});

describe("opening the Bank's app does not disturb WhatsApp", () => {
  beforeEach(async () => {
    await start();
  });

  it("leaves a live Binding on the same account working", async () => {
    // Had in-app chat created a Binding, one-live-Binding-per-account would
    // have revoked the Customer's WhatsApp access on every app launch.
    await harness.seedBinding(WHATSAPP_NUMBER, ACCOUNT);

    const conversationId = await signedIn();
    await exchangeInApp(harness, { conversationId, said: "balance" });

    await postWebhook(
      harness,
      saidPayload({ phoneNumberId: "test-phone-number-id", from: WHATSAPP_NUMBER, text: "balance" }),
    );

    expect(await waitForReplies(harness)).toEqual(["Your available balance is ₦1,000,000."]);
  });

  it("does not refresh a WhatsApp Binding's dormancy clock", async () => {
    // The other direction, and the subtler one. In-app activity must not keep
    // alive a Binding on a number that has gone quiet — dormancy expiry exists
    // because the operator recycles the number, and the handset in somebody
    // else's hand is not made safe by the real Customer using the app.
    await harness.seedBinding(WHATSAPP_NUMBER, ACCOUNT);
    harness.clock.advance(91 * 24 * 60 * 60 * 1000);

    const conversationId = await signedIn();
    await exchangeInApp(harness, { conversationId, said: "balance" });

    await postWebhook(
      harness,
      saidPayload({ phoneNumberId: "test-phone-number-id", from: WHATSAPP_NUMBER, text: "balance" }),
    );
    const [reply] = await waitForReplies(harness);

    expect(reply).not.toContain("₦");
  });
});

describe("nothing branches on which Channel it is", () => {
  beforeEach(async () => {
    await start();
  });

  it("answers the same sentence with the same words on both", async () => {
    // The composer describes and the adapter renders. The only difference
    // between the two Channels is how the answer is delivered, and this is that
    // claim as an assertion rather than as a comment.
    await harness.seedBinding(WHATSAPP_NUMBER, ACCOUNT);

    const conversationId = await signedIn();
    const inApp = await exchangeInApp(harness, { conversationId, said: "what's my balance" });

    await postWebhook(
      harness,
      saidPayload({
        phoneNumberId: "test-phone-number-id",
        from: WHATSAPP_NUMBER,
        text: "what's my balance",
      }),
    );
    const [onWhatsApp] = await waitForReplies(harness);

    expect(inApp.reply?.["text"]).toBe(onWhatsApp);
  });

  it("keeps said and chose apart here exactly as it does there", async () => {
    const conversationId = await signedIn();
    const before = harness.groq.calls.length;

    await exchangeInApp(harness, { conversationId, chose: "unlink_cancel" });

    // A tapped control is routed by code. A Customer who *types* the text of a
    // button reaches the model; one who taps it does not.
    expect(harness.groq.calls).toHaveLength(before);
  });

  it("refuses a message that is neither", async () => {
    const conversationId = await signedIn();

    expect(await exchangeInApp(harness, { conversationId })).toMatchObject({ status: 400 });
  });
});

describe("the loader-to-server contract", () => {
  beforeEach(async () => {
    await start();
  });

  it("serves the Widget the Snippet asks for", async () => {
    const response = await fetch(`${harness.platformUrl}/widget/v1/widget.js`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("javascript");
    expect(await response.text()).toContain("AvniChat");
  });

  it("agrees with the Snippet about where the panel is and what carries the identity", async () => {
    // The two deployables share no code (ADR-0003), so the mount id and the
    // global the loader writes are re-typed on each side. Nothing but this
    // notices them drifting apart, and the symptom would be a panel that loads
    // and then does nothing — no error, no message, just a dead rectangle
    // inside the Bank's application.
    const loader = snippet.snippet;
    const widget = await (await fetch(`${harness.platformUrl}/widget/v1/widget.js`)).text();

    const mountId = /getElementById\("([^"]+)"\)/.exec(loader)?.[1];
    const global = /w\.(\w+) = \{ version/.exec(loader)?.[1];

    expect(mountId).toBeDefined();
    expect(global).toBeDefined();
    expect(loader).toContain(`<div id="${mountId}">`);
    expect(widget).toContain(`window.${global}`);
  });

  it("serves every version the Middleware can mint a Snippet for", async () => {
    // The two deployables share no code (ADR-0003), so the only place their
    // two lists can be held to agreeing is here. A version the Middleware
    // pastes into a Bank's application and the Platform does not serve is a
    // panel that never loads, on handsets nobody can recall.
    for (const version of CONTRACT_VERSIONS) {
      const response = await fetch(`${harness.platformUrl}/widget/${version}/widget.js`);
      expect(response.status).toBe(200);
    }
  });

  it("does not quietly upgrade a handset asking for a version it does not serve", async () => {
    // A Snippet inside a shipped application cannot be recalled, so a contract
    // change is served alongside the old one. Answering the newest Widget to a
    // loader written against another contract is the failure that would make.
    const response = await fetch(`${harness.platformUrl}/widget/v9/widget.js`);

    expect(response.status).toBe(404);
  });

  it("refuses to talk to a version it does not serve", async () => {
    expect(await openInApp(harness, identityFor(), "v9")).toMatchObject({ status: 404 });
  });

  it("answers a conversation it never opened with a 404 rather than a reply", async () => {
    const strangerId = "00000000-0000-4000-8000-000000000000";

    expect(
      await exchangeInApp(harness, { conversationId: strangerId, said: "balance" }),
    ).toMatchObject({ status: 404 });
  });

  it("refuses to drive a WhatsApp conversation from a handset", async () => {
    // The escalation the Channel check exists for. A WhatsApp conversation
    // resolves its account through a **Binding**, so a Widget that could name
    // one would be reading whichever Customer holds it — no envelope, no
    // signature, nothing signed at all.
    await harness.seedBinding(WHATSAPP_NUMBER, ACCOUNT);
    await postWebhook(
      harness,
      saidPayload({ phoneNumberId: "test-phone-number-id", from: WHATSAPP_NUMBER, text: "balance" }),
    );
    await waitForReplies(harness);

    const { token } = await harness.signInStaff("administrator");
    const audit = await fetch(
      `${harness.middlewareUrl}/dashboard/audit?action=conversation.opened`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    const { entries } = (await audit.json()) as { entries: { conversationId: string | null }[] };
    const whatsappConversation = entries.find((entry) => entry.conversationId)?.conversationId;
    expect(whatsappConversation).toBeDefined();

    expect(
      await exchangeInApp(harness, {
        conversationId: whatsappConversation as string,
        said: "balance",
      }),
    ).toMatchObject({ status: 404 });
  });

  it("keeps working after the Platform forgets everything it held in memory", async () => {
    // A conversation lives in the Middleware's database, not in the Platform's
    // memory. This was an in-process `Set` first, which meant a restart — or a
    // second Platform replica — stopped answering a panel that was still open.
    const conversationId = await signedIn();
    await exchangeInApp(harness, { conversationId, said: "balance" });

    await harness.restartPlatform();

    const { reply } = await exchangeInApp(harness, { conversationId, said: "balance" });
    expect(reply).toMatchObject({ text: "Your available balance is ₦1,000,000." });
  });
});

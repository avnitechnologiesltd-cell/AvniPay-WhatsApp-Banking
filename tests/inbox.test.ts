import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  attachmentPayload,
  chosePayload,
  deliveryReceiptPayload,
  saidPayload,
} from "@avni/fakes";

import { postWebhook, startHarness, waitFor, waitForReplies, type Harness } from "./harness";

/**
 * The **Inbox**: where a Support Officer sees and answers a handed-off
 * conversation.
 *
 * One shared list, an exclusive claim, and a claim that expires when the Officer
 * goes quiet. Auto-assignment was rejected for v1 — it needs presence tracking
 * and staffing rules that do not exist yet — and what a shared list needs
 * instead is exactly the concurrency control this file is about.
 *
 * `tests/handoff.test.ts` drives the same slice from the Customer's side.
 */

const CUSTOMER = "2348012345678";
const ACCOUNT = "0123456789";
const PHONE_NUMBER_ID = "test-phone-number-id";

let harness: Harness;

const envelope = { phoneNumberId: PHONE_NUMBER_ID, from: CUSTOMER };

interface InboxEntry {
  readonly handoffId: string;
  readonly conversationId: string;
  readonly trigger: string;
  readonly summary: string;
  readonly channel: string;
  readonly accountNumber: string | null;
  readonly claimedBy: { readonly id: string; readonly displayName: string } | null;
}

interface HistoryLine {
  readonly id: string;
  readonly direction: string;
  readonly kind: string;
  readonly body: string;
  readonly author: string;
  readonly attachment: { readonly messageId: string; readonly mediaType: string; readonly name: string } | null;
}

const start = async (options: Parameters<typeof startHarness>[0] = {}): Promise<void> => {
  harness = await startHarness({
    accounts: [{ accountNumber: ACCOUNT, availableBalance: 1_000_000 }],
    unentitled: ["GetTransactions"],
    ...options,
  });
  await harness.seedBinding(CUSTOMER, ACCOUNT);
};

const authed = (token: string) => ({ authorization: `Bearer ${token}` });

const inbox = async (token: string): Promise<readonly InboxEntry[]> => {
  const response = await fetch(`${harness.middlewareUrl}/dashboard/inbox`, {
    headers: authed(token),
  });
  const { conversations } = (await response.json()) as { conversations: InboxEntry[] };
  return conversations;
};

const view = async (
  token: string,
  handoffId: string,
): Promise<InboxEntry & { history: readonly HistoryLine[]; resolvedAt: string | null }> => {
  const response = await fetch(`${harness.middlewareUrl}/dashboard/inbox/${handoffId}`, {
    headers: authed(token),
  });
  return (await response.json()) as never;
};

const claim = (token: string, handoffId: string): Promise<Response> =>
  fetch(`${harness.middlewareUrl}/dashboard/inbox/${handoffId}/claim`, {
    method: "POST",
    headers: authed(token),
  });

const reply = (token: string, handoffId: string, body: string): Promise<Response> =>
  fetch(`${harness.middlewareUrl}/dashboard/inbox/${handoffId}/reply`, {
    method: "POST",
    headers: { ...authed(token), "content-type": "application/json" },
    body: JSON.stringify({ body }),
  });

const resolve = (token: string, handoffId: string): Promise<Response> =>
  fetch(`${harness.middlewareUrl}/dashboard/inbox/${handoffId}/resolve`, {
    method: "POST",
    headers: authed(token),
  });

/** Asks for a human and waits for the Handoff to land in the Inbox. */
const handedOff = async (token: string, text = "I want a human"): Promise<InboxEntry> => {
  await postWebhook(harness, saidPayload({ ...envelope, text }));
  return waitFor(async () => (await inbox(token))[0], "a Handoff in the Inbox");
};

const auditRows = async (
  action: string,
): Promise<readonly { outcome: string; actorKind: string; detail: Record<string, unknown> }[]> => {
  const { token } = await harness.signInStaff("administrator");
  const response = await fetch(
    `${harness.middlewareUrl}/dashboard/audit?action=${encodeURIComponent(action)}`,
    { headers: authed(token) },
  );
  const { entries } = (await response.json()) as { entries: never[] };
  return entries;
};

afterEach(async () => {
  await harness?.stop();
});

// --- What the Officer is handed ----------------------------------------------

describe("what the Officer receives", () => {
  beforeEach(async () => {
    await start();
  });

  it("is the said/chose/event history rather than a flat transcript", async () => {
    // The distinction that matters most in the case an Officer will actually be
    // called about: somebody paid the wrong person. Did they **type** a name, or
    // **tap** a row the platform rendered? Those are different failures with
    // different owners.
    const { token } = await harness.signInStaff("support_officer");

    await postWebhook(harness, saidPayload({ ...envelope, text: "unlink my number", messageId: "m1" }));
    await waitForReplies(harness, 1);
    await postWebhook(harness, chosePayload({ ...envelope, id: "unlink_cancel", messageId: "m2" }));
    await waitForReplies(harness, 2);
    const handoff = await handedOff(token);

    const { history } = await view(token, handoff.handoffId);
    const inbound = history.filter((line) => line.direction === "inbound");

    expect(inbound.map((line) => [line.kind, line.body])).toEqual([
      ["said", "unlink my number"],
      ["chose", "unlink_cancel"],
      ["said", "I want a human"],
    ]);
  });

  it("carries the events too, so a completed Flow is not invisible", async () => {
    // The third of `said`/`chose`/`event`. A Flow the Customer finished and a
    // message that never reached them are exactly the kind of thing an Officer
    // is about to be asked about, and neither is a message they typed.
    const { token } = await harness.signInStaff("support_officer");
    await postWebhook(harness, saidPayload({ ...envelope, text: "balance", messageId: "m1" }));
    await waitForReplies(harness, 1);

    await postWebhook(
      harness,
      deliveryReceiptPayload({ ...envelope, messageId: "wamid.out.1", status: "read" }),
    );
    const handoff = await handedOff(token, "I want a human");

    const events = await waitFor(
      async () => {
        const { history } = await view(token, handoff.handoffId);
        const found = history.filter((line) => line.kind === "event");
        return found.length > 0 ? found : undefined;
      },
      "the delivery receipt in the Officer's view",
    );
    expect(events[0]).toMatchObject({ direction: "inbound", body: "delivery_receipt" });
  });

  it("does not let a delivery receipt count as the Customer getting in touch", async () => {
    // An `event` says a message *we* sent arrived. Treating it as contact would
    // refresh a Binding's dormancy clock and reopen WhatsApp's 24-hour window on
    // the strength of our own message — which is exactly what both rules exist
    // to prevent.
    const officer = await harness.signInStaff("support_officer");
    const handoff = await handedOff(officer.token);
    await claim(officer.token, handoff.handoffId);
    harness.clock.advance(25 * 60 * 60 * 1000);

    await postWebhook(
      harness,
      deliveryReceiptPayload({ ...envelope, messageId: "wamid.out.1", status: "read" }),
    );
    await waitFor(
      async () =>
        (await view(officer.token, handoff.handoffId)).history.some(
          (line) => line.kind === "event",
        ) || undefined,
      "the delivery receipt recorded",
    );

    // The Officer's own claim lapsed over those 25 hours, so they pick it back
    // up — which is the ordinary next-morning shape and not what is under test.
    await claim(officer.token, handoff.handoffId);

    // Still shut, so the Officer's words are held behind the template. Had the
    // receipt counted as contact, this would have gone out as plain text.
    const answered = await reply(officer.token, handoff.handoffId, "Sorted.");
    expect(await answered.json()).toMatchObject({ delivery: "template" });
  });

  it("carries what the Agent already said, so nothing is asked twice", async () => {
    const { token } = await harness.signInStaff("support_officer");
    const handoff = await handedOff(token);

    const { history } = await view(token, handoff.handoffId);
    const agent = history.filter((line) => line.author === "agent");

    expect(agent).not.toHaveLength(0);
    expect(agent.at(-1)?.body).toContain("member of our team");
  });

  it("names the trigger, the Channel, the account and the Agent's summary", async () => {
    const { token } = await harness.signInStaff("support_officer");
    const handoff = await handedOff(token);

    expect(handoff).toMatchObject({
      trigger: "customer_asked",
      channel: "whatsapp",
      accountNumber: ACCOUNT,
    });
    expect(handoff.summary).not.toHaveLength(0);
  });

  it("preserves the conversation id rather than minting a fresh one", async () => {
    // Audit, the Mandate's own clock and the Officer seeing one conversation
    // rather than two all depend on it. Originally it mattered because a
    // verification record hung off the id; Gated deleted that record and the
    // rule survives for every other reason.
    const { token } = await harness.signInStaff("support_officer");

    await postWebhook(harness, saidPayload({ ...envelope, text: "balance", messageId: "m1" }));
    await waitForReplies(harness, 1);
    const opened = await auditRows("conversation.opened");
    const before = (opened as unknown as { conversationId: string | null }[]).find(
      (row) => row.conversationId,
    )?.conversationId;

    const handoff = await handedOff(token);

    expect(before).toBeDefined();
    expect(handoff.conversationId).toBe(before);
  });

  it("shows the account an in-app conversation was opened against instead", async () => {
    // The two Channels resolve identity differently and this is the one place
    // an Officer sees the difference: WhatsApp through the Binding, in-app from
    // what the Bank's backend signed.
    const { token } = await harness.signInStaff("support_officer");
    const snippet = await harness.generateSnippet();
    const { signInAppIdentity } = await import("@avni/fakes");
    const identity = signInAppIdentity(snippet.secret, {
      accountNumber: ACCOUNT,
      expiresAt: new Date(harness.clock.now().getTime() + 60 * 60 * 1000),
    });

    const opened = await fetch(`${harness.platformUrl}/widget/v1/conversations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identity }),
    });
    const { conversationId } = (await opened.json()) as { conversationId: string };
    await fetch(`${harness.platformUrl}/widget/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId, said: "let me talk to a person" }),
    });

    const handoff = await waitFor(async () => (await inbox(token))[0], "the in-app Handoff");
    expect(handoff).toMatchObject({ channel: "in_app_chat", accountNumber: ACCOUNT });
  });
});

// --- The claim ---------------------------------------------------------------

describe("a claim is exclusive", () => {
  beforeEach(async () => {
    await start();
  });

  it("lets one Officer take it and refuses the second", async () => {
    const amaka = await harness.signInStaff("support_officer");
    const bola = await harness.signInStaff("support_officer");
    const handoff = await handedOff(amaka.token);

    expect((await claim(amaka.token, handoff.handoffId)).status).toBe(201);

    const second = await claim(bola.token, handoff.handoffId);
    expect(second.status).toBe(409);
    expect(await second.text()).toContain("already answering");
  });

  it("refuses the second Officer even when both press at once", async () => {
    // The ordinary Monday-morning case rather than an exotic race, and the
    // reason the claim is a conditional update rather than a read-then-write.
    const amaka = await harness.signInStaff("support_officer");
    const bola = await harness.signInStaff("support_officer");
    const handoff = await handedOff(amaka.token);

    const [first, second] = await Promise.all([
      claim(amaka.token, handoff.handoffId),
      claim(bola.token, handoff.handoffId),
    ]);

    expect([first?.status, second?.status].sort()).toEqual([201, 409]);
  });

  it("shows the holder to everybody looking at the list", async () => {
    const amaka = await harness.signInStaff("support_officer");
    const bola = await harness.signInStaff("support_officer");
    const handoff = await handedOff(amaka.token);
    await claim(amaka.token, handoff.handoffId);

    const seenByBola = (await inbox(bola.token))[0];
    expect(seenByBola?.claimedBy?.displayName).toBe("Staff 1");
  });

  it("lets the same Officer reclaim what they already hold", async () => {
    const amaka = await harness.signInStaff("support_officer");
    const handoff = await handedOff(amaka.token);

    await claim(amaka.token, handoff.handoffId);
    expect((await claim(amaka.token, handoff.handoffId)).status).toBe(201);
  });

  it("refuses a reply from an Officer who never claimed it", async () => {
    const amaka = await harness.signInStaff("support_officer");
    const bola = await harness.signInStaff("support_officer");
    const handoff = await handedOff(amaka.token);
    await claim(amaka.token, handoff.handoffId);

    expect((await reply(bola.token, handoff.handoffId, "hello")).status).toBe(409);
    expect(harness.whatsapp.transcript()).not.toContain("hello");
  });
});

describe("a claim expires on Officer inactivity", () => {
  beforeEach(async () => {
    await start();
  });

  it("returns the conversation to the queue", async () => {
    // Otherwise a conversation is held hostage by somebody who went home with
    // it open, which is the failure that actually happens.
    const amaka = await harness.signInStaff("support_officer");
    const bola = await harness.signInStaff("support_officer");
    const handoff = await handedOff(amaka.token);
    await claim(amaka.token, handoff.handoffId);

    harness.clock.advance(31 * 60 * 1000);

    expect((await inbox(bola.token))[0]?.claimedBy).toBeNull();
    expect((await claim(bola.token, handoff.handoffId)).status).toBe(201);
  });

  it("does not expire while the Officer is working it", async () => {
    const amaka = await harness.signInStaff("support_officer");
    const bola = await harness.signInStaff("support_officer");
    const handoff = await handedOff(amaka.token);
    await claim(amaka.token, handoff.handoffId);

    // Twenty minutes, a reply, twenty more. Each act refreshes the claim, so
    // the total is longer than the window and the claim is still hers.
    harness.clock.advance(20 * 60 * 1000);
    expect((await reply(amaka.token, handoff.handoffId, "still here")).status).toBe(201);
    harness.clock.advance(20 * 60 * 1000);

    expect((await claim(bola.token, handoff.handoffId)).status).toBe(409);
  });

  it("stops the lapsed Officer replying until they claim it again", async () => {
    const amaka = await harness.signInStaff("support_officer");
    const handoff = await handedOff(amaka.token);
    await claim(amaka.token, handoff.handoffId);
    harness.clock.advance(31 * 60 * 1000);

    expect((await reply(amaka.token, handoff.handoffId, "sorry, back")).status).toBe(409);

    expect((await claim(amaka.token, handoff.handoffId)).status).toBe(201);
    expect((await reply(amaka.token, handoff.handoffId, "sorry, back")).status).toBe(201);
  });

  it("introduces the second Officer when they take over a lapsed claim", async () => {
    // Otherwise the Customer is introduced to Amaka, answered by Bola under
    // Amaka's name, and finally told *"Bola has closed this chat"* — a name
    // they have never heard. Told by name in **both** directions means told
    // whenever the name changes.
    const amaka = await harness.signInStaff("support_officer");
    const bola = await harness.signInStaff("support_officer");
    const handoff = await handedOff(amaka.token);
    await claim(amaka.token, handoff.handoffId);
    harness.clock.advance(31 * 60 * 1000);

    await claim(bola.token, handoff.handoffId);

    expect(harness.whatsapp.transcript()).toContain(
      "You're now speaking with Staff 2 from Example MFB.",
    );
  });

  it("does not reintroduce the Officer to the Customer on a reclaim", async () => {
    // *"You're now speaking with Amaka"* is true once. Saying it again every
    // time a claim lapses would be the platform narrating its own plumbing.
    const amaka = await harness.signInStaff("support_officer");
    const handoff = await handedOff(amaka.token);
    await claim(amaka.token, handoff.handoffId);
    harness.clock.advance(31 * 60 * 1000);
    await claim(amaka.token, handoff.handoffId);

    const introductions = harness.whatsapp
      .transcript()
      .filter((words) => words.includes("You're now speaking with"));
    expect(introductions).toHaveLength(1);
  });
});

// --- The Customer is told, by name -------------------------------------------

describe("the Customer is told by name, in both directions", () => {
  beforeEach(async () => {
    await start();
  });

  it("names the Officer and the Bank when they arrive", async () => {
    const amaka = await harness.signInStaff("support_officer");
    const handoff = await handedOff(amaka.token);

    await claim(amaka.token, handoff.handoffId);

    expect(harness.whatsapp.transcript()).toContain(
      "You're now speaking with Staff 1 from Example MFB.",
    );
  });

  it("names them again when they close it, and says the Agent is back", async () => {
    // Swapping a human for an AI without saying so is a disclosure problem for
    // a licensed institution, and it costs one sentence.
    const amaka = await harness.signInStaff("support_officer");
    const handoff = await handedOff(amaka.token);
    await claim(amaka.token, handoff.handoffId);

    await resolve(amaka.token, handoff.handoffId);

    expect(harness.whatsapp.transcript().at(-1)).toBe(
      "Staff 1 has closed this chat — I'm back if you need anything else.",
    );
  });

  it("delivers the Officer's own words to the Customer", async () => {
    const amaka = await harness.signInStaff("support_officer");
    const handoff = await handedOff(amaka.token);
    await claim(amaka.token, handoff.handoffId);

    await reply(amaka.token, handoff.handoffId, "I can see the transfer. Give me a moment.");

    expect(harness.whatsapp.transcript()).toContain(
      "I can see the transfer. Give me a moment.",
    );
  });

  it("keeps the Officer's reply out of the audit table's detail", async () => {
    // The words are in the conversation, which is where the Bank reads what was
    // said. The audit row records that an Officer answered and how it went out.
    const amaka = await harness.signInStaff("support_officer");
    const handoff = await handedOff(amaka.token);
    await claim(amaka.token, handoff.handoffId);
    await reply(amaka.token, handoff.handoffId, "your account ends 6789");

    const rows = await auditRows("handoff.replied");
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain("6789");
    expect(rows[0]?.detail).toMatchObject({ delivery: "sent" });
  });

  it("refuses an empty reply rather than sending a blank message", async () => {
    const amaka = await harness.signInStaff("support_officer");
    const handoff = await handedOff(amaka.token);
    await claim(amaka.token, handoff.handoffId);

    expect((await reply(amaka.token, handoff.handoffId, "   ")).status).toBe(400);
  });
});

// --- Who may work the Inbox ---------------------------------------------------

describe("who may work the Inbox", () => {
  beforeEach(async () => {
    await start();
  });

  it("is both roles, because every Administrator is also a Support Officer", async () => {
    const admin = await harness.signInStaff("administrator");
    const handoff = await handedOff(admin.token);

    expect((await claim(admin.token, handoff.handoffId)).status).toBe(201);
  });

  it("records every read, because looking is the sensitive act here", async () => {
    const amaka = await harness.signInStaff("support_officer");
    const handoff = await handedOff(amaka.token);
    await view(amaka.token, handoff.handoffId);

    const rows = await auditRows("inbox.read");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((row) => row.detail["handoffId"] === handoff.handoffId)).toBe(true);
  });

  it("refuses anybody without a session", async () => {
    const response = await fetch(`${harness.middlewareUrl}/dashboard/inbox`);
    expect(response.status).toBe(401);
  });

  it("answers a Handoff nobody raised with a 404", async () => {
    const { token } = await harness.signInStaff("support_officer");
    const response = await fetch(
      `${harness.middlewareUrl}/dashboard/inbox/00000000-0000-4000-8000-000000000000`,
      { headers: authed(token) },
    );

    expect(response.status).toBe(404);
  });
});

// --- Attachments ---------------------------------------------------------------

describe("a file the Customer sent", () => {
  const RECEIPT = { id: "media-1", mimeType: "image/jpeg", bytes: Buffer.from("receipt-bytes") };

  beforeEach(async () => {
    await start({ media: [RECEIPT] });
  });

  const sentAFile = async (token: string, filename = "receipt.jpg"): Promise<InboxEntry> => {
    await postWebhook(harness, attachmentPayload({ ...envelope, mediaId: RECEIPT.id, filename }));
    return waitFor(async () => (await inbox(token))[0], "the Handoff for the file");
  };

  it("appears in the history as a file that exists, and not as its contents", async () => {
    const { token } = await harness.signInStaff("support_officer");
    const handoff = await sentAFile(token);

    const { history } = await view(token, handoff.handoffId);
    const withFile = history.find((line) => line.attachment);

    expect(withFile?.attachment).toMatchObject({ mediaType: "image/jpeg", name: "receipt.jpg" });
    // The key is the Middleware's business and the Dashboard names a message.
    expect(JSON.stringify(withFile)).not.toContain("conversations/");
  });

  it("is served to the Officer reading the conversation", async () => {
    const { token } = await harness.signInStaff("support_officer");
    const handoff = await sentAFile(token);
    const { history } = await view(token, handoff.handoffId);
    const messageId = history.find((line) => line.attachment)?.attachment?.messageId;

    const file = await fetch(
      `${harness.middlewareUrl}/dashboard/inbox/${handoff.handoffId}/attachments/${messageId}`,
      { headers: authed(token) },
    );

    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("image/jpeg");
    expect(await file.text()).toBe("receipt-bytes");
  });

  it("is never rendered inline in a member of staff's browser", async () => {
    // The Customer chose the bytes and the filename. A document rendered inline
    // in the Dashboard is a Customer choosing what the Bank's staff load.
    const { token } = await harness.signInStaff("support_officer");
    const handoff = await sentAFile(token);
    const { history } = await view(token, handoff.handoffId);
    const messageId = history.find((line) => line.attachment)?.attachment?.messageId;

    const file = await fetch(
      `${harness.middlewareUrl}/dashboard/inbox/${handoff.handoffId}/attachments/${messageId}`,
      { headers: authed(token) },
    );

    expect(file.headers.get("content-disposition")).toBe("attachment");
    expect(file.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("refuses a message id belonging to somebody else's conversation", async () => {
    const { token } = await harness.signInStaff("support_officer");
    const handoff = await sentAFile(token);
    const { history } = await view(token, handoff.handoffId);
    const messageId = history.find((line) => line.attachment)?.attachment?.messageId;

    // A second Customer's Handoff, and the first Customer's file id.
    const other = "2348099999999";
    await harness.seedBinding(other, "0987654321");
    await postWebhook(
      harness,
      saidPayload({ phoneNumberId: PHONE_NUMBER_ID, from: other, text: "I want a human" }),
    );
    const theirs = await waitFor(
      async () => (await inbox(token)).find((entry) => entry.conversationId !== handoff.conversationId),
      "the second Handoff",
    );

    const file = await fetch(
      `${harness.middlewareUrl}/dashboard/inbox/${theirs.handoffId}/attachments/${messageId}`,
      { headers: authed(token) },
    );

    expect(file.status).toBe(404);
  });

  it("records who opened it", async () => {
    const { token } = await harness.signInStaff("support_officer");
    const handoff = await sentAFile(token);
    const { history } = await view(token, handoff.handoffId);
    const messageId = history.find((line) => line.attachment)?.attachment?.messageId;

    await fetch(
      `${harness.middlewareUrl}/dashboard/inbox/${handoff.handoffId}/attachments/${messageId}`,
      { headers: authed(token) },
    );

    const rows = await auditRows("attachment.read");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actorKind).toBe("officer");
  });

  it("is unreachable without a Dashboard session", async () => {
    const { token } = await harness.signInStaff("support_officer");
    const handoff = await sentAFile(token);
    const { history } = await view(token, handoff.handoffId);
    const messageId = history.find((line) => line.attachment)?.attachment?.messageId;

    const file = await fetch(
      `${harness.middlewareUrl}/dashboard/inbox/${handoff.handoffId}/attachments/${messageId}`,
    );

    expect(file.status).toBe(401);
  });

  it("is not reachable through the Platform at all", async () => {
    // The Platform wrote these bytes without opening them and holds a
    // credential that cannot read them back. There is no route here, and that
    // is the assertion: not that the route refuses, that it does not exist.
    const { token } = await harness.signInStaff("support_officer");
    const handoff = await sentAFile(token);
    const [stored] = [...harness.objectStore.objects.values()];

    for (const path of [
      `/attachments/${stored?.key}`,
      `/widget/v1/attachments/${stored?.key}`,
      `/platform/conversations/${handoff.conversationId}/attachments`,
    ]) {
      const response = await fetch(`${harness.platformUrl}${path}`);
      expect(response.status).toBe(404);
    }
  });
});

// --- Settings ------------------------------------------------------------------

describe("the settings this slice produced", () => {
  beforeEach(async () => {
    await start();
  });

  const write = (token: string, key: string, value: unknown): Promise<Response> =>
    fetch(`${harness.middlewareUrl}/dashboard/settings`, {
      method: "PUT",
      headers: { ...authed(token), "content-type": "application/json" },
      body: JSON.stringify({ key, value }),
    });

  const hours = {
    timeZone: "Africa/Lagos",
    days: {
      monday: { opens: "08:00", closes: "18:00" },
      tuesday: { opens: "08:00", closes: "18:00" },
      wednesday: { opens: "08:00", closes: "18:00" },
      thursday: { opens: "08:00", closes: "18:00" },
      friday: { opens: "08:00", closes: "18:00" },
      saturday: null,
      sunday: null,
    },
  };

  it("start unset rather than at hours nobody at the Bank ever said", async () => {
    const { token } = await harness.signInStaff("support_officer");
    const response = await fetch(`${harness.middlewareUrl}/dashboard/settings`, {
      headers: authed(token),
    });

    expect(await response.json()).toEqual({
      businessHours: null,
      operationsAlertAddress: "",
    });
  });

  it("let a Support Officer read and an Administrator write", async () => {
    // Ticket 28 drew this line and these two are why it was worth a role: the
    // hours decide what a Customer is told, and the address decides who is
    // woken at 3am.
    const officer = await harness.signInStaff("support_officer");
    const admin = await harness.signInStaff("administrator");

    expect((await write(officer.token, "business_hours", hours)).status).toBe(403);
    expect((await write(admin.token, "business_hours", hours)).status).toBe(200);

    const read = await fetch(`${harness.middlewareUrl}/dashboard/settings`, {
      headers: authed(officer.token),
    });
    expect(await read.json()).toMatchObject({ businessHours: { timeZone: "Africa/Lagos" } });
  });

  it("refuse hours that are not hours, with a reason an Administrator can act on", async () => {
    const admin = await harness.signInStaff("administrator");

    const response = await write(admin.token, "business_hours", {
      ...hours,
      days: { ...hours.days, monday: { opens: "18:00", closes: "08:00" } },
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("close after it opens");
  });

  it("refuse an operations address that is not an address", async () => {
    const admin = await harness.signInStaff("administrator");

    expect((await write(admin.token, "operations_alert_address", "the ops team")).status).toBe(400);
    expect(
      (await write(admin.token, "operations_alert_address", "operations@bank.example")).status,
    ).toBe(200);
  });

  it("refuse a key nobody defined", async () => {
    const admin = await harness.signInStaff("administrator");

    expect((await write(admin.token, "sentiment_threshold", 0.5)).status).toBe(400);
  });

  it("record who read and who changed one", async () => {
    const admin = await harness.signInStaff("administrator");
    const officer = await harness.signInStaff("support_officer");

    await write(admin.token, "operations_alert_address", "operations@bank.example");
    await write(officer.token, "operations_alert_address", "me@bank.example");

    const written = await auditRows("settings.write");
    expect(written.map((row) => row.outcome).sort()).toEqual(["refused", "succeeded"]);
    // The address is not a secret, and *which setting somebody tried to change*
    // is the question an investigation starts from.
    expect(written.some((row) => row.detail["key"] === "operations_alert_address")).toBe(true);
  });
});

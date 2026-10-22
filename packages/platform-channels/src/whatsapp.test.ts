import { afterEach, describe, expect, it } from "vitest";

import {
  chosePayload,
  deliveryReceiptPayload,
  flowReplyPayload,
  saidPayload,
  startFakeWhatsApp,
  type FakeWhatsApp,
} from "@avni/fakes";

import { readWebhook, WhatsAppSender } from "./whatsapp";

const PHONE_NUMBER_ID = "test-phone-number-id";
const API_TOKEN = "test-graph-token";
const CUSTOMER = "2348012345678";

const envelope = { phoneNumberId: PHONE_NUMBER_ID, from: CUSTOMER };

describe("readWebhook", () => {
  it("reads typed text as said", () => {
    const inbound = readWebhook(saidPayload({ ...envelope, text: "what's my balance" }));

    expect(inbound).toEqual([
      {
        kind: "said",
        channel: "whatsapp",
        channelIdentity: CUSTOMER,
        externalId: expect.any(String),
        text: "what's my balance",
      },
    ]);
  });

  it("reads a tapped control as chose, carrying the id we minted", () => {
    const inbound = readWebhook(chosePayload({ ...envelope, id: "menu_transfer" }));

    expect(inbound[0]).toMatchObject({ kind: "chose", id: "menu_transfer" });
  });

  it("keeps a typed string apart from the same string tapped", () => {
    // The distinction the whole split exists for. Flattened, these two are the
    // same value and every handler downstream has to defend itself.
    const typed = readWebhook(saidPayload({ ...envelope, text: "menu_transfer" }))[0];
    const tapped = readWebhook(chosePayload({ ...envelope, id: "menu_transfer" }))[0];

    expect(typed?.kind).toBe("said");
    expect(tapped?.kind).toBe("chose");
  });

  it("reads a delivery receipt as an event rather than a message", () => {
    const inbound = readWebhook(deliveryReceiptPayload({ ...envelope, status: "delivered" }));

    expect(inbound[0]).toMatchObject({ kind: "event", event: "delivery_receipt" });
  });

  it("reads a completed Flow's reply as an event", () => {
    // The Flow endpoint at the Middleware already did the work; this is the
    // receipt, not the instruction.
    const inbound = readWebhook(
      flowReplyPayload({ ...envelope, responseJson: '{"ok":true}' }),
    );

    expect(inbound[0]).toMatchObject({ kind: "event", event: "flow_reply" });
  });

  it("drops empty text rather than passing a blank said upward", () => {
    expect(readWebhook(saidPayload({ ...envelope, text: "   " }))).toEqual([]);
  });

  it("accepts an unreadable payload quietly, because Meta retries a non-200", () => {
    for (const body of [{}, null, undefined, { entry: [] }, { entry: [{ changes: [{}] }] }]) {
      expect(readWebhook(body)).toEqual([]);
    }
  });

  it("reads every message in a webhook that carries several", () => {
    const both = {
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: {
                messages: [
                  { from: CUSTOMER, id: "1", type: "text", text: { body: "hello" } },
                  {
                    from: CUSTOMER,
                    id: "2",
                    type: "interactive",
                    interactive: { type: "button_reply", button_reply: { id: "yes" } },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    expect(readWebhook(both).map((message) => message.kind)).toEqual(["said", "chose"]);
  });
});

describe("WhatsAppSender", () => {
  let whatsapp: FakeWhatsApp;

  afterEach(async () => {
    await whatsapp?.close();
  });

  const senderFor = (fake: FakeWhatsApp): WhatsAppSender =>
    new WhatsAppSender({
      graphApiBaseUrl: fake.url,
      apiToken: API_TOKEN,
      phoneNumberId: PHONE_NUMBER_ID,
    });

  it("renders say as a text message the Customer reads", async () => {
    whatsapp = await startFakeWhatsApp({ apiToken: API_TOKEN, phoneNumberId: PHONE_NUMBER_ID });

    await senderFor(whatsapp).send(CUSTOMER, { verb: "say", text: "Your balance is ₦1,000,000." });

    expect(whatsapp.transcript()).toEqual(["Your balance is ₦1,000,000."]);
    expect(whatsapp.sent[0]).toMatchObject({ to: CUSTOMER, type: "text" });
  });

  it("renders ask with the ids that will come back as a chose", async () => {
    whatsapp = await startFakeWhatsApp({ apiToken: API_TOKEN, phoneNumberId: PHONE_NUMBER_ID });

    await senderFor(whatsapp).send(CUSTOMER, {
      verb: "ask",
      question: "Which account?",
      choices: [{ id: "acct_1", label: "Savings" }],
    });

    const sent = whatsapp.sent[0]?.raw as {
      interactive?: { action?: { buttons?: { reply?: { id?: string } }[] } };
    };
    expect(sent.interactive?.action?.buttons?.[0]?.reply?.id).toBe("acct_1");
  });

  it("authenticates as the Bank's WhatsApp account", async () => {
    whatsapp = await startFakeWhatsApp({ apiToken: API_TOKEN, phoneNumberId: PHONE_NUMBER_ID });

    await senderFor(whatsapp).send(CUSTOMER, { verb: "say", text: "hello" });

    expect(whatsapp.requests[0]?.headers["authorization"]).toBe(`Bearer ${API_TOKEN}`);
    expect(whatsapp.requests[0]?.path).toContain(PHONE_NUMBER_ID);
  });

  it("raises rather than silently dropping a message WhatsApp declined", async () => {
    whatsapp = await startFakeWhatsApp({ apiToken: "a-different-token", phoneNumberId: PHONE_NUMBER_ID });

    await expect(senderFor(whatsapp).send(CUSTOMER, { verb: "say", text: "hello" })).rejects.toThrow();
  });
});

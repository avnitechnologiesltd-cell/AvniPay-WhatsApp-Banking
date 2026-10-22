import type { Inbound, Outbound } from "./message";

/**
 * The WhatsApp adapter. Turns Meta's webhook payloads into the three inbound
 * shapes, and the four outbound verbs into Graph API calls.
 *
 * Everything WhatsApp-specific stops here. Nothing above this file knows that
 * a button reply arrives under `interactive.button_reply.id`, and nothing below
 * it knows what an Intent is.
 */

interface GraphMedia {
  id?: string;
  mime_type?: string;
  caption?: string;
  filename?: string;
}

interface GraphMessage {
  from?: string;
  id?: string;
  type?: string;
  text?: { body?: string };
  image?: GraphMedia;
  document?: GraphMedia;
  audio?: GraphMedia;
  video?: GraphMedia;
  interactive?: {
    type?: string;
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string };
    nfm_reply?: { response_json?: string; name?: string };
  };
}

interface GraphStatus {
  id?: string;
  recipient_id?: string;
  status?: string;
}

interface GraphValue {
  messages?: GraphMessage[];
  statuses?: GraphStatus[];
}

interface GraphWebhook {
  object?: string;
  entry?: { changes?: { field?: string; value?: GraphValue }[] }[];
}

/**
 * Normalises a webhook body into zero or more inbound messages.
 *
 * Returns an array because one webhook may carry several, and returns an empty
 * one for anything unrecognised rather than throwing — Meta retries a webhook
 * it did not get a 200 for, so a payload we cannot read must be accepted and
 * dropped rather than retried forever.
 */
export const readWebhook = (body: unknown): readonly Inbound[] => {
  const webhook = (body ?? {}) as GraphWebhook;
  const inbound: Inbound[] = [];

  for (const entry of webhook.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};

      for (const message of value.messages ?? []) {
        const normalised = readMessage(message);
        if (normalised) inbound.push(normalised);
      }

      // A delivery receipt is inbound but is not a message. Recorded for audit,
      // never acted on, and never shown to a model.
      for (const status of value.statuses ?? []) {
        inbound.push({
          kind: "event",
          event: "delivery_receipt",
          channel: "whatsapp",
          channelIdentity: status.recipient_id ?? "",
          externalId: status.id ?? "",
          detail: { status: status.status ?? "" },
        });
      }
    }
  }

  return inbound;
};

const readMessage = (message: GraphMessage): Inbound | undefined => {
  const base = {
    channel: "whatsapp",
    channelIdentity: message.from ?? "",
    externalId: message.id ?? "",
  } as const;

  if (message.type === "text") {
    const text = message.text?.body?.trim() ?? "";
    return text ? { ...base, kind: "said", text } : undefined;
  }

  // A file. **The caption travels with it and is still not `said` on its own**
  // — the message carries an attachment, and an attachment takes the whole turn
  // off the model's path. Four media types rather than two because a Customer
  // sending a voice note is not sending nothing, and a shape this layer did not
  // recognise would be silently dropped.
  const media = message.image ?? message.document ?? message.audio ?? message.video;
  if (media?.id && MEDIA_TYPES.has(message.type ?? "")) {
    return {
      ...base,
      kind: "said",
      text: media.caption?.trim() ?? "",
      attachment: {
        mediaId: media.id,
        mediaType: media.mime_type ?? "application/octet-stream",
        filename: media.filename ?? "",
      },
    };
  }

  if (message.type === "interactive") {
    const interactive = message.interactive ?? {};

    // A completed Flow's reply. The Flow endpoint already did the work at the
    // Middleware; this is the receipt, not the instruction.
    if (interactive.type === "nfm_reply") {
      return {
        ...base,
        kind: "event",
        event: "flow_reply",
        detail: { responseJson: interactive.nfm_reply?.response_json ?? "" },
      };
    }

    // An id we minted, coming back unchanged. Note it arrives in the same
    // `messages` array as free text — which is exactly why the two must not be
    // read into the same field.
    const id = interactive.button_reply?.id ?? interactive.list_reply?.id;
    if (id) return { ...base, kind: "chose", id };
  }

  return undefined;
};

const MEDIA_TYPES = new Set(["image", "document", "audio", "video"]);

export interface WhatsAppSenderOptions {
  readonly graphApiBaseUrl: string;
  readonly apiToken: string;
  readonly phoneNumberId: string;
  readonly fetch?: typeof globalThis.fetch;
}

/** Renders the outbound verbs to the Graph API. */
export class WhatsAppSender {
  private readonly fetch: typeof globalThis.fetch;

  public constructor(private readonly options: WhatsAppSenderOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  /**
   * Marks the Customer's message read and shows the typing indicator.
   *
   * One call does both — Meta's read receipt carries the indicator — and it is
   * **best-effort by design**: a Customer whose typing dots failed should still
   * get their answer, so a failure here is logged by the caller rather than
   * raised. The indicator expires on its own after about 25 seconds, or when
   * the reply lands.
   */
  public async showTyping(messageId: string): Promise<void> {
    const url = `${this.options.graphApiBaseUrl.replace(/\/+$/, "")}/${this.options.phoneNumberId}/messages`;

    await this.fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.options.apiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId,
        typing_indicator: { type: "text" },
      }),
    });
  }

  public async send(to: string, message: Outbound): Promise<void> {
    const url = `${this.options.graphApiBaseUrl.replace(/\/+$/, "")}/${this.options.phoneNumberId}/messages`;

    const response = await this.fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.options.apiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ messaging_product: "whatsapp", to, ...render(message) }),
    });

    if (!response.ok) {
      throw new Error(`WhatsApp declined the message: HTTP ${response.status}`);
    }
  }
}

const render = (message: Outbound): Record<string, unknown> => {
  switch (message.verb) {
    case "say":
      return { type: "text", text: { body: message.text } };

    case "ask":
      return {
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: message.question },
          action: {
            buttons: message.choices.map((choice) => ({
              type: "reply",
              // The id we mint here is the id that comes back as a `chose`.
              reply: { id: choice.id, title: choice.label },
            })),
          },
        },
      };

    case "send":
      return {
        type: "document",
        document: {
          link: message.documentUrl,
          ...(message.caption === undefined ? {} : { caption: message.caption }),
        },
      };

    case "secure":
      return {
        type: "interactive",
        interactive: {
          type: "flow",
          body: { text: message.purpose },
          action: {
            name: "flow",
            parameters: {
              flow_message_version: "3",
              // The token is the Middleware's; the id is the published Flow's.
              // Neither is a value this layer can read or reconstruct.
              flow_token: message.token,
              flow_id: message.flowId,
              flow_cta: message.callToAction,
              // Endpoint mode: the Flow exchanges data with the Middleware
              // rather than collecting it and posting it back through here.
              flow_action: "navigate",
            },
          },
        },
      };
  }
};

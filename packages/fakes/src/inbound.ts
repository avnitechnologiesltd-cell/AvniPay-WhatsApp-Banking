/**
 * Inbound WhatsApp webhook payloads, in the shape Meta actually posts.
 *
 * These are test *inputs* rather than a fake service — the Platform's webhook
 * is a real endpoint a test pushes into, so what it needs is a faithful
 * payload. They live here because the three shapes below are exactly the
 * `said` / `chose` / `event` split, and getting one wrong would let a test pass
 * against a distinction that had collapsed.
 */

export interface WebhookEnvelopeOptions {
  readonly phoneNumberId: string;
  readonly from: string;
  readonly messageId?: string;
  readonly timestamp?: string;
}

const envelope = (
  options: WebhookEnvelopeOptions,
  value: Record<string, unknown>,
): Record<string, unknown> => ({
  object: "whatsapp_business_account",
  entry: [
    {
      id: "fake-waba-id",
      changes: [
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: {
              display_phone_number: "0000000000",
              phone_number_id: options.phoneNumberId,
            },
            ...value,
          },
        },
      ],
    },
  ],
});

const stamp = (options: WebhookEnvelopeOptions) => ({
  from: options.from,
  id: options.messageId ?? `wamid.inbound.${options.from}`,
  timestamp: options.timestamp ?? "1700000000",
});

/**
 * Free text the Customer composed. **The only thing the model is ever shown**,
 * and therefore the platform's injection surface.
 */
export const saidPayload = (
  options: WebhookEnvelopeOptions & { readonly text: string },
): Record<string, unknown> =>
  envelope(options, {
    contacts: [{ profile: { name: "Test Customer" }, wa_id: options.from }],
    messages: [{ ...stamp(options), type: "text", text: { body: options.text } }],
  });

/**
 * A control the Customer tapped, carrying back an identifier the platform
 * minted. Routed by code, never by a model — and note it arrives on the same
 * webhook, in the same `messages` array, as the free text above. Flattening
 * them is the mistake this split exists to prevent.
 */
export const chosePayload = (
  options: WebhookEnvelopeOptions & { readonly id: string; readonly title?: string },
): Record<string, unknown> =>
  envelope(options, {
    contacts: [{ profile: { name: "Test Customer" }, wa_id: options.from }],
    messages: [
      {
        ...stamp(options),
        type: "interactive",
        interactive: {
          type: "button_reply",
          button_reply: { id: options.id, title: options.title ?? options.id },
        },
      },
    ],
  });

/**
 * A file the Customer sent — a photographed receipt, which is ordinary support.
 *
 * The caption is text they composed and would otherwise be `said`, and it is
 * carried here so a test can prove the thing that matters: **an attachment never
 * reaches a model, caption or not.** A document handed to the layer running the
 * LLM is an injection vector with a file extension, and the Customer chooses the
 * filename too.
 */
export const attachmentPayload = (
  options: WebhookEnvelopeOptions & {
    readonly mediaId: string;
    readonly mimeType?: string;
    readonly filename?: string;
    readonly caption?: string;
    readonly kind?: "image" | "document";
  },
): Record<string, unknown> => {
  const kind = options.kind ?? "image";
  const mimeType = options.mimeType ?? (kind === "image" ? "image/jpeg" : "application/pdf");

  return envelope(options, {
    contacts: [{ profile: { name: "Test Customer" }, wa_id: options.from }],
    messages: [
      {
        ...stamp(options),
        type: kind,
        [kind]: {
          id: options.mediaId,
          mime_type: mimeType,
          ...(options.caption === undefined ? {} : { caption: options.caption }),
          ...(options.filename === undefined ? {} : { filename: options.filename }),
        },
      },
    ],
  });
};

/** A delivery receipt. Inbound, but not a message — the Orchestration Layer never sees one. */
export const deliveryReceiptPayload = (
  options: WebhookEnvelopeOptions & { readonly status?: string },
): Record<string, unknown> =>
  envelope(options, {
    statuses: [
      {
        id: options.messageId ?? "wamid.outbound.1",
        recipient_id: options.from,
        status: options.status ?? "delivered",
        timestamp: options.timestamp ?? "1700000000",
      },
    ],
  });

/** A completed Flow's reply. Also an `event`: the Flow endpoint already did the work. */
export const flowReplyPayload = (
  options: WebhookEnvelopeOptions & { readonly responseJson: string },
): Record<string, unknown> =>
  envelope(options, {
    contacts: [{ profile: { name: "Test Customer" }, wa_id: options.from }],
    messages: [
      {
        ...stamp(options),
        type: "interactive",
        interactive: {
          type: "nfm_reply",
          nfm_reply: {
            name: "flow",
            body: "Sent",
            response_json: options.responseJson,
          },
        },
      },
    ],
  });

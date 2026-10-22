import { respondJson, startFake, type FakeService } from "./server";

/**
 * The WhatsApp Graph API's send endpoint, and its media endpoints.
 *
 * This fake is where a test learns **what the Customer actually received**,
 * which is the only thing a journey test should assert about an outbound
 * reply. The composer describes (`say`, `ask`, `send`, `secure`) and the
 * adapter renders; this records the rendering.
 *
 * The media half is the other direction and is deliberately two hops, because
 * Meta's is: a webhook carries a media **id**, `GET /{id}` answers with a
 * short-lived URL, and the bytes come from that URL with the same bearer token.
 * A fake that handed the bytes back in one call would let the Platform's media
 * client skip the hop that actually breaks in production.
 */

export interface SentMessage {
  readonly to: string;
  readonly type: string;
  /** The words, for whichever message type carries them. */
  readonly text: string;
  readonly raw: Readonly<Record<string, unknown>>;
}

/** A file the Bank's WhatsApp account is holding for a Customer to fetch. */
export interface FakeMedia {
  readonly id: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

export interface FakeWhatsAppOptions {
  readonly apiToken: string;
  readonly phoneNumberId: string;
  /** Media a Customer has already sent, keyed by the id the webhook carries. */
  readonly media?: readonly FakeMedia[];
}

export interface FakeWhatsApp extends FakeService {
  readonly sent: readonly SentMessage[];
  /**
   * Every read receipt, which is also where the typing indicator rides. Not a
   * message, and deliberately a separate list — a test that waits for the next
   * *reply* must not be handed the typing dots.
   */
  readonly readReceipts: readonly { readonly messageId: string; readonly typing: boolean }[];
  /** What the Customer would see, oldest first. */
  readonly transcript: () => readonly string[];
  /** Templates only — the business-initiated messages that draw on the tier. */
  readonly templates: () => readonly SentMessage[];
  /** Adds a file mid-test, the way a Customer sending one would. */
  readonly holdMedia: (media: FakeMedia) => void;
}

interface SendBody {
  to?: string;
  type?: string;
  text?: { body?: string };
  interactive?: { body?: { text?: string } };
  template?: { name?: string };
  [key: string]: unknown;
}

const wordsOf = (body: SendBody): string =>
  body.text?.body ?? body.interactive?.body?.text ?? body.template?.name ?? "";

export const startFakeWhatsApp = async (
  options: FakeWhatsAppOptions,
): Promise<FakeWhatsApp> => {
  const sent: SentMessage[] = [];
  const readReceipts: { messageId: string; typing: boolean }[] = [];
  const media = new Map<string, FakeMedia>(
    (options.media ?? []).map((one) => [one.id, one]),
  );
  // Filled in once the ephemeral port is known, because the URL this fake hands
  // back for a media id has to be one the Platform can actually fetch.
  let base = "";

  const service = await startFake((request, response) => {
    if (request.headers["authorization"] !== `Bearer ${options.apiToken}`) {
      respondJson(response, 401, {
        error: { message: "Invalid OAuth access token", type: "OAuthException", code: 190 },
      });
      return;
    }

    const segments = request.path.split("/").filter(Boolean);

    // The bytes, at the URL the lookup below handed out.
    if (segments[0] === "media" && segments[2] === "bytes") {
      const held = media.get(segments[1] ?? "");
      if (!held) {
        respondJson(response, 404, { error: { message: "no such media" } });
        return;
      }
      response.writeHead(200, { "content-type": held.mimeType });
      response.end(Buffer.from(held.bytes));
      return;
    }

    // `GET /{media-id}` — the lookup. Answers a URL and a MIME type, never bytes.
    if (request.method === "GET" && segments.length === 1) {
      const held = media.get(segments[0] ?? "");
      if (!held) {
        respondJson(response, 404, { error: { message: "no such media" } });
        return;
      }
      respondJson(response, 200, {
        id: held.id,
        url: `${base}/media/${held.id}/bytes`,
        mime_type: held.mimeType,
        file_size: held.bytes.byteLength,
      });
      return;
    }

    const [phoneNumberId, resource] = segments.slice(-2);
    if (resource !== "messages") {
      respondJson(response, 404, { error: { message: `no fake for ${request.path}` } });
      return;
    }
    if (phoneNumberId !== options.phoneNumberId) {
      respondJson(response, 400, {
        error: { message: "Unknown phone number id", type: "GraphMethodException", code: 100 },
      });
      return;
    }

    const body = (request.body ?? {}) as SendBody & {
      status?: string;
      message_id?: string;
      typing_indicator?: { type?: string };
    };

    // **A read receipt is not a message.** It goes to the same endpoint and
    // Meta does not count it as one — recording it here would make every test
    // that waits for "the next reply" get the typing indicator instead, which
    // is exactly what happened when this was missing.
    if (body.status === "read") {
      readReceipts.push({
        messageId: body.message_id ?? "",
        typing: body.typing_indicator?.type !== undefined,
      });
      respondJson(response, 200, { success: true });
      return;
    }

    sent.push({
      to: body.to ?? "",
      type: body.type ?? "",
      text: wordsOf(body),
      raw: body as Readonly<Record<string, unknown>>,
    });

    respondJson(response, 200, {
      messaging_product: "whatsapp",
      contacts: [{ input: body.to ?? "", wa_id: body.to ?? "" }],
      messages: [{ id: `wamid.fake.${sent.length}` }],
    });
  });

  base = service.url;

  return {
    ...service,
    sent,
    readReceipts,
    transcript: () => sent.map((message) => message.text),
    templates: () => sent.filter((message) => message.type === "template"),
    holdMedia: (one) => {
      media.set(one.id, one);
    },
  };
};

/**
 * Fetching a file a Customer sent, from WhatsApp's media API.
 *
 * **Bytes the Platform moves, never content the Platform reads.** There is no
 * parse in this file, no sniff, no branch on what the file turns out to be — a
 * `Uint8Array` goes in one end of this deployable and out the other into object
 * storage, and the only thing anything downstream learns is that a file exists.
 * That is not stylistic restraint; the layer this runs in reads Customer text
 * into a model, and a document opened here would be an injection vector with a
 * file extension.
 *
 * Two hops, because Meta's API is two hops: the webhook carries a media **id**,
 * `GET /{id}` answers with a short-lived URL, and the bytes come from that URL
 * with the same bearer token.
 */

export interface WhatsAppMediaOptions {
  readonly graphApiBaseUrl: string;
  readonly apiToken: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  /**
   * The largest file this will move. WhatsApp caps uploads at 100MB and the
   * Bank's Officers are looking at receipts; a bound here is what stops a single
   * message from being a memory event in the deployable that answers everybody.
   */
  readonly maxBytes?: number;
}

export type MediaFetch =
  | { readonly outcome: "fetched"; readonly bytes: Uint8Array; readonly mediaType: string }
  /** The id is unknown, expired, or the file is larger than we will move. */
  | { readonly outcome: "unavailable"; readonly reason: string };

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

export class WhatsAppMedia {
  private readonly baseUrl: string;
  private readonly fetch: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;

  public constructor(private readonly options: WhatsAppMediaOptions) {
    this.baseUrl = options.graphApiBaseUrl.replace(/\/+$/, "");
    this.fetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  public async download(mediaId: string): Promise<MediaFetch> {
    const found = await this.locate(mediaId);
    if (found.outcome === "unavailable") return found;

    const response = await this.get(found.url);
    if (!response || !response.ok) {
      return { outcome: "unavailable", reason: `media bytes answered HTTP ${response?.status}` };
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > this.maxBytes) {
      return { outcome: "unavailable", reason: `media is larger than ${this.maxBytes} bytes` };
    }

    return {
      outcome: "fetched",
      bytes,
      // **From the lookup, not from the bytes.** Sniffing a magic number would
      // be this layer reading the file, and the type is only ever a hint the
      // Dashboard renders anyway.
      mediaType: found.mediaType,
    };
  }

  private async locate(
    mediaId: string,
  ): Promise<
    | { readonly outcome: "located"; readonly url: string; readonly mediaType: string }
    | { readonly outcome: "unavailable"; readonly reason: string }
  > {
    const response = await this.get(`${this.baseUrl}/${encodeURIComponent(mediaId)}`);
    if (!response || !response.ok) {
      return { outcome: "unavailable", reason: `media lookup answered HTTP ${response?.status}` };
    }

    const body = (await response.json()) as { url?: unknown; mime_type?: unknown };
    if (typeof body.url !== "string") {
      return { outcome: "unavailable", reason: "the media lookup carried no URL" };
    }

    return {
      outcome: "located",
      url: body.url,
      mediaType: typeof body.mime_type === "string" ? body.mime_type : "application/octet-stream",
    };
  }

  private async get(url: string): Promise<Response | undefined> {
    try {
      return await this.fetch(url, {
        headers: { authorization: `Bearer ${this.options.apiToken}` },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      return undefined;
    }
  }
}

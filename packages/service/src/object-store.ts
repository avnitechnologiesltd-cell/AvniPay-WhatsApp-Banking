import { createHash, createHmac } from "node:crypto";

/**
 * **Object storage on the Bank's infrastructure**, where a Customer's
 * attachments live.
 *
 * The rule this file exists to make structural: *the Platform writes a file
 * without ever opening it, and only the Dashboard reads one.* A document handed
 * to the layer running the LLM is an injection vector with a file extension, and
 * the Customer chooses the filename too — so the Platform downloads the bytes
 * from WhatsApp's media API and puts them here, and nothing in that deployable
 * ever gets them back.
 *
 * **Two interfaces rather than one, and that is the whole design.** The Platform
 * is constructed with an {@link ObjectWriter} and the Middleware with an
 * {@link ObjectReader}. Neither is a subset of the other by convention — they
 * are different types with one method each, so "the Platform cannot read an
 * attachment" is something the compiler enforces rather than something a
 * reviewer notices. The deployment splits the credentials the same way
 * (ticket 41); this is the half that holds even when it does not.
 *
 * S3-compatible over HTTP with SigV4, and no SDK. The bucket is MinIO in
 * development and whatever the Bank runs in production; the ~80 lines of
 * signing below are the entire cost of not taking a dependency on an AWS SDK to
 * make two request shapes.
 */

/** What the Platform is given: somewhere to put bytes, and nothing else. */
export interface ObjectWriter {
  /** Stores `bytes` under `key`. Throws if the store would not take them. */
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
}

/** What the Middleware is given, so the Dashboard can serve one file. */
export interface ObjectReader {
  /** Reads `key` back, or `undefined` if the store does not hold it. */
  get(key: string): Promise<StoredObject | undefined>;
}

/**
 * Both halves, and **the Middleware alone is ever given one**.
 *
 * The Library is the reason this exists. A Library document is bytes an
 * *Administrator* supplied and the platform reads on purpose, which is the exact
 * opposite of an attachment's rule — so the deployable that ingests one has to
 * be able to put it there as well as read it back.
 *
 * That does not weaken the split above, because the split was never symmetric.
 * The property being defended is *"the Platform cannot read a Customer's
 * documents"*, and the Platform is still handed an {@link ObjectWriter} with no
 * `get` on it. What changes is only that the Middleware's own credential must
 * carry write on the bucket, and the two prefixes stay disjoint: the Platform
 * writes `conversations/…` and never reads, the Middleware writes and reads
 * `library/…` and reads `conversations/…`.
 */
export interface ObjectStore extends ObjectWriter, ObjectReader {}

export interface StoredObject {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

export interface ObjectStoreOptions {
  /** The S3-compatible endpoint. MinIO in development, the Bank's in production. */
  readonly endpoint: string;
  readonly bucket: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

/**
 * The one implementation, exposed through whichever of the two interfaces the
 * caller was handed.
 *
 * It implements both, because there is one bucket and one protocol. What stops
 * the Platform reading is that it is never given this type — it is given an
 * `ObjectWriter`, and an `ObjectWriter` has no `get`.
 */
export class S3ObjectStore implements ObjectWriter, ObjectReader {
  private readonly endpoint: string;
  private readonly fetch: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  public constructor(private readonly options: ObjectStoreOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, "");
    this.fetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  public async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    const response = await this.send("PUT", key, bytes, contentType);
    if (!response.ok) {
      throw new Error(`Object storage declined ${key}: HTTP ${response.status}`);
    }
  }

  public async get(key: string): Promise<StoredObject | undefined> {
    const response = await this.send("GET", key);
    if (response.status === 404) return undefined;
    if (!response.ok) {
      throw new Error(`Object storage declined ${key}: HTTP ${response.status}`);
    }

    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      contentType: response.headers.get("content-type") ?? "application/octet-stream",
    };
  }

  private async send(
    method: "GET" | "PUT",
    key: string,
    bytes?: Uint8Array,
    contentType?: string,
  ): Promise<Response> {
    const path = `/${this.options.bucket}/${encodeKey(key)}`;
    const url = new URL(`${this.endpoint}${path}`);
    const payload = bytes ?? new Uint8Array();
    const payloadHash = sha256Hex(payload);
    const stamp = timestamp();

    const headers: Record<string, string> = {
      host: url.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": stamp.long,
      ...(contentType ? { "content-type": contentType } : {}),
    };

    headers["authorization"] = this.authorization(method, path, headers, payloadHash, stamp);

    return this.fetch(url, {
      method,
      headers,
      ...(method === "PUT" ? { body: payload } : {}),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }

  /**
   * AWS Signature Version 4, the subset two request shapes need.
   *
   * No query string is ever signed here, because neither request has one — a
   * presigned URL would be an attachment reachable without a Dashboard session,
   * which is the opposite of what this store is for.
   */
  private authorization(
    method: string,
    path: string,
    headers: Readonly<Record<string, string>>,
    payloadHash: string,
    stamp: Stamp,
  ): string {
    const signedHeaders = Object.keys(headers).sort();
    const canonicalHeaders = signedHeaders
      .map((name) => `${name}:${(headers[name] ?? "").trim()}\n`)
      .join("");

    const canonicalRequest = [
      method,
      path,
      "",
      canonicalHeaders,
      signedHeaders.join(";"),
      payloadHash,
    ].join("\n");

    const scope = `${stamp.short}/${this.options.region}/s3/aws4_request`;
    const toSign = [
      "AWS4-HMAC-SHA256",
      stamp.long,
      scope,
      sha256Hex(Buffer.from(canonicalRequest, "utf8")),
    ].join("\n");

    let signing: Buffer = Buffer.from(`AWS4${this.options.secretAccessKey}`, "utf8");
    for (const part of [stamp.short, this.options.region, "s3", "aws4_request"]) {
      signing = hmac(signing, part);
    }

    const signature = hmac(signing, toSign).toString("hex");

    return (
      `AWS4-HMAC-SHA256 Credential=${this.options.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders.join(";")}, Signature=${signature}`
    );
  }
}

interface Stamp {
  readonly long: string;
  readonly short: string;
}

/**
 * **Real wall-clock, and deliberately not the workspace `Clock`.**
 *
 * SigV4 signs the timestamp and the far side rejects a request more than a few
 * minutes out of skew. A test clock advanced by a day would produce a signature
 * S3 refuses — so this is the one place in the workspace where a moved clock
 * would break the thing rather than test it.
 */
const timestamp = (): Stamp => {
  const long = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { long, short: long.slice(0, 8) };
};

const sha256Hex = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const hmac = (key: Buffer, value: string): Buffer =>
  createHmac("sha256", key).update(value, "utf8").digest();

/**
 * Percent-encodes each path segment, leaving the separators alone.
 *
 * Keys are minted by the platform and are already `[a-z0-9/-]`, so this never
 * fires in practice — it is here so that a later key format cannot silently
 * become a path traversal against somebody else's object.
 */
const encodeKey = (key: string): string =>
  key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

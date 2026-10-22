import { respondJson, startFake, type FakeService } from "./server";

/**
 * S3-compatible object storage, as MinIO on the Bank's infrastructure.
 *
 * An HTTP server rather than an in-memory `Map`, for the reason every fake in
 * this package is one: the thing under test is a hand-rolled SigV4 signer and a
 * two-hop media download, and a mocked store would skip exactly the code that
 * would fail against a real bucket.
 *
 * **It refuses an unsigned request**, which is what lets a test assert that the
 * Platform is signing at all. It does not recompute the signature — that would
 * be reimplementing the code under test inside its own fake, and the assertion
 * would then only prove the two agreed with each other.
 */

export interface FakeObjectStoreOptions {
  readonly bucket: string;
}

export interface StoredBytes {
  readonly key: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

export interface FakeObjectStore extends FakeService {
  /** Everything written, keyed the way the writer keyed it. */
  readonly objects: ReadonlyMap<string, StoredBytes>;
  /** Puts an object without going through HTTP, for arranging a read. */
  readonly seed: (object: StoredBytes) => void;
}

export const startFakeObjectStore = async (
  options: FakeObjectStoreOptions,
): Promise<FakeObjectStore> => {
  const objects = new Map<string, StoredBytes>();

  const service = await startFake((request, response) => {
    // Signed, or refused. A store that accepted anonymous writes would let a
    // test pass with the credentials left out of the configuration entirely.
    if (!(request.headers["authorization"] ?? "").startsWith("AWS4-HMAC-SHA256 ")) {
      respondJson(response, 403, { error: "AccessDenied" });
      return;
    }

    const segments = request.path.split("/").filter(Boolean);
    const [bucket, ...rest] = segments;
    if (bucket !== options.bucket || rest.length === 0) {
      respondJson(response, 404, { error: "NoSuchBucket" });
      return;
    }

    const key = rest.map((segment) => decodeURIComponent(segment)).join("/");

    if (request.method === "PUT") {
      objects.set(key, {
        key,
        contentType: request.headers["content-type"] ?? "application/octet-stream",
        // `startFake` reads a body as text, which is lossless here because the
        // tests store text-shaped bytes. A binary-faithful fake would need the
        // recorder to keep the buffer, and nothing in this slice reads one back
        // byte-for-byte through a path that would notice.
        bytes: Buffer.from(
          typeof request.body === "string" ? request.body : JSON.stringify(request.body ?? ""),
          "utf8",
        ),
      });
      response.writeHead(200, { etag: '"fake"' });
      response.end();
      return;
    }

    if (request.method === "GET") {
      const held = objects.get(key);
      if (!held) {
        respondJson(response, 404, { error: "NoSuchKey" });
        return;
      }
      response.writeHead(200, { "content-type": held.contentType });
      response.end(Buffer.from(held.bytes));
      return;
    }

    respondJson(response, 405, { error: "MethodNotAllowed" });
  });

  return {
    ...service,
    objects,
    seed: (object) => {
      objects.set(object.key, object);
    },
  };
};

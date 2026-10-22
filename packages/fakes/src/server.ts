import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * The fakes are **HTTP servers, not mocked classes**, and that distinction is
 * the point of this package. BankOne returns `"1,000,000.00"` with separators,
 * spells its success flag two ways, and names its auth field differently on
 * three endpoints. A mocked adapter class would skip precisely the code that
 * has to survive all of it — the code Appendix A says will silently destroy
 * money if it does not.
 *
 * Each fake is injected by base-URL configuration, which already exists because
 * the Bank's BankOne tenancy is not the development one. No production seam is
 * added for testing.
 */

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export interface FakeService {
  /** Where to point the configuration. */
  readonly url: string;
  /** Every request this fake received, in order, for assertions afterwards. */
  readonly requests: readonly RecordedRequest[];
  readonly close: () => Promise<void>;
}

export type Handler = (
  request: RecordedRequest,
  response: ServerResponse,
) => void | Promise<void>;

const readBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;

  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
};

/** Starts `handler` on an ephemeral port and records everything it receives. */
/**
 * Where a fake listens. Defaults to an ephemeral port on loopback, which is
 * what a test wants: no port to collide with, and nothing reachable off the
 * machine.
 *
 * Overridden only when something *outside this process* has to reach the fake —
 * running one beside the Compose stack so the Middleware container can call it,
 * which is the case the Bank's identity API has while the Bank has not built it
 * yet. A container reaches the host over the bridge rather than over loopback,
 * so that case needs both a fixed port to configure and a wider bind address.
 */
export interface FakeListen {
  readonly host?: string;
  readonly port?: number;
}

export const startFake = async (
  handler: Handler,
  listen: FakeListen = {},
): Promise<FakeService> => {
  const requests: RecordedRequest[] = [];

  const server: Server = createServer((incoming, response) => {
    void (async () => {
      const url = new URL(incoming.url ?? "/", "http://fake.invalid");
      const recorded: RecordedRequest = {
        method: incoming.method ?? "GET",
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: Object.fromEntries(
          Object.entries(incoming.headers).map(([name, value]) => [
            name,
            Array.isArray(value) ? value.join(", ") : (value ?? ""),
          ]),
        ),
        body: await readBody(incoming),
      };
      requests.push(recorded);

      try {
        await handler(recorded, response);
      } catch (error) {
        respondJson(response, 500, { error: String(error) });
      }
      if (!response.writableEnded) respondJson(response, 404, { error: "no route" });
    })();
  });

  const host = listen.host ?? "127.0.0.1";
  await new Promise<void>((resolve) => server.listen(listen.port ?? 0, host, resolve));
  const { port } = server.address() as AddressInfo;

  return {
    // `0.0.0.0` is a bind address rather than somewhere to send a request, so
    // the URL says loopback whenever the caller widened the bind.
    url: `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

export const respondJson = (
  response: ServerResponse,
  status: number,
  body: unknown,
): void => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

export const respondText = (
  response: ServerResponse,
  status: number,
  body: string,
): void => {
  response.writeHead(status, { "content-type": "text/plain" });
  response.end(body);
};

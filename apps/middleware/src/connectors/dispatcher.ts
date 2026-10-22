import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";

import { addressProblem, endpointProblem } from "./egress";

/**
 * The one thing in this platform that makes an outbound HTTP call to an address
 * somebody typed into a form.
 *
 * Five rules, and the whole of the SSRF answer is that they hold **at connect
 * time** rather than at registration:
 *
 * 1. Resolve the hostname.
 * 2. **Refuse** loopback, private, link-local, cloud-metadata and reserved
 *    ranges — on the resolved address, not on the text of the URL.
 * 3. **Connect to that exact address.** The name is never resolved a second
 *    time, so a record that changes between the check and the connection
 *    changes nothing.
 * 4. **Never follow a redirect.** A `302` to `169.254.169.254` is the same
 *    attack with no DNS involved, so a redirect is an answer this refuses
 *    rather than a hop it takes.
 * 5. HTTPS, with certificate verification on. Nothing here sets
 *    `rejectUnauthorized`, and the day somebody does, the credential the Bank
 *    pasted into a form starts travelling to whoever answered.
 *
 * The interface is separate from the implementation for one reason and it is
 * the same reason the clock is injected: a Connector endpoint is on the public
 * internet **by policy**, and a test's fake Bank API is necessarily on
 * loopback. The tests below drive the real class for everything that does not
 * need a live server, and the end-to-end journeys stand a fake in for the
 * network itself rather than weakening rule 2 to let a test through.
 */

export interface ConnectorCall {
  /** The registered endpoint. Re-checked here; never trusted from the row. */
  readonly endpoint: string;
  readonly headers: Readonly<Record<string, string>>;
  /** The envelope. Ours; the field names inside `parameters` are the Bank's. */
  readonly body: unknown;
}

export type DispatchOutcome =
  /**
   * The Bank's endpoint answered. **The status is the audit row and the body is
   * not** — a response body is Bank data we have no reason to retain, and it is
   * untrusted model-facing text on its way back to the Support Agent.
   */
  | { readonly outcome: "answered"; readonly status: number; readonly body: string }
  /** The call was refused by policy: egress, scheme, or a redirect. */
  | { readonly outcome: "refused"; readonly problem: string }
  /** Nobody answered: DNS, connection, TLS or the timeout. */
  | { readonly outcome: "unreachable"; readonly problem: string };

export interface ConnectorDispatcher {
  send(call: ConnectorCall): Promise<DispatchOutcome>;
}

/**
 * How long a Connector may take before the Middleware gives up on it.
 *
 * **A starting value rather than a finding**, and ticket 18 left it open on
 * purpose: picking it properly wants a real endpoint to measure and there are
 * none yet. What it protects is real — the Middleware's availability now bounds
 * the support path as well as the banking one (ADR-0005), so a Connector
 * pointing at a slow endpoint must not be able to hold a request open.
 */
export const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * What is read back from the Bank's endpoint, at most.
 *
 * The body goes to the Support Agent as untrusted text, so it is bounded for the
 * same reason Library retrieval is: it is about to be multiplied against every
 * turn of a conversation, against Groq's 250K TPM.
 */
export const MAX_RESPONSE_BYTES = 8_192;

/** One resolved address, in the shape `dns.lookup` answers with. */
interface ResolvedAddress {
  readonly address: string;
  readonly family: number;
}

type Resolve = (hostname: string) => Promise<readonly ResolvedAddress[]>;

const systemResolve: Resolve = async (hostname) => lookup(hostname, { all: true });

export class PinnedHttpsDispatcher implements ConnectorDispatcher {
  private readonly resolve: Resolve;
  private readonly timeoutMs: number;

  /**
   * @param options The DNS resolver and the timeout, injected for the same
   * reason the clock is: a test cannot make a real name resolve to a private
   * address, and *that* is the case this class exists for. **There is no seam
   * for the address policy itself** — no argument here can make loopback
   * acceptable, which is what keeps rule 2 a rule.
   */
  public constructor(options: { readonly resolve?: Resolve; readonly timeoutMs?: number } = {}) {
    this.resolve = options.resolve ?? systemResolve;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  public async send(call: ConnectorCall): Promise<DispatchOutcome> {
    const scheme = endpointProblem(call.endpoint);
    if (scheme) return { outcome: "refused", problem: scheme };

    // Parsed after `endpointProblem`, which has already refused anything this
    // would throw on.
    const url = new URL(call.endpoint);

    let addresses: readonly ResolvedAddress[];
    try {
      addresses = await this.resolve(url.hostname);
    } catch (error) {
      return { outcome: "unreachable", problem: `${url.hostname} did not resolve: ${reasonFor(error)}` };
    }

    if (addresses.length === 0) {
      return { outcome: "unreachable", problem: `${url.hostname} resolved to nothing` };
    }

    // **Every address, not the one we happen to use.** A name that answers with
    // a public address and a private one is a name that reaches the Bank's
    // network on whichever the resolver hands over next.
    for (const resolved of addresses) {
      const problem = addressProblem(resolved.address);
      if (problem) {
        return { outcome: "refused", problem: `${url.hostname} resolves to ${problem}` };
      }
    }

    const pinned = addresses[0] as ResolvedAddress;
    return this.post(url, pinned, call);
  }

  private post(url: URL, pinned: ResolvedAddress, call: ConnectorCall): Promise<DispatchOutcome> {
    const body = Buffer.from(JSON.stringify(call.body), "utf8");

    return new Promise<DispatchOutcome>((resolve) => {
      let settled = false;
      const answer = (outcome: DispatchOutcome): void => {
        if (settled) return;
        settled = true;
        resolve(outcome);
      };

      const request = httpsRequest(
        {
          // The **hostname** for the `Host` header and for SNI, so the
          // certificate is verified against the name the Bank registered — and
          // the **address** for the connection, through the pinned lookup below.
          host: url.hostname,
          servername: url.hostname,
          port: url.port === "" ? 443 : Number(url.port),
          path: `${url.pathname}${url.search}`,
          method: "POST",
          headers: {
            ...call.headers,
            "content-type": "application/json",
            "content-length": String(body.byteLength),
          },
          timeout: this.timeoutMs,
          // **The name is never resolved twice.** This hands back the address
          // already checked above rather than asking the resolver again, which
          // is what closes the window between the check and the connection.
          lookup: (_hostname, _options, callback) => {
            (callback as (error: null, address: string, family: number) => void)(
              null,
              pinned.address,
              pinned.family,
            );
          },
          // No pooling. A kept-alive socket is a connection somebody else's
          // resolution opened, which would quietly undo the pinning above.
          agent: false,
        },
        (response) => {
          const status = response.statusCode ?? 0;

          const redirect = redirectProblem(status, response.headers["location"]);
          if (redirect) {
            response.destroy();
            answer({ outcome: "refused", problem: redirect });
            return;
          }

          const chunks: Buffer[] = [];
          let read = 0;
          response.on("data", (chunk: Buffer) => {
            read += chunk.byteLength;
            if (read <= MAX_RESPONSE_BYTES) chunks.push(chunk);
            else response.destroy();
          });
          response.on("end", () => {
            answer({
              outcome: "answered",
              status,
              body: Buffer.concat(chunks).toString("utf8").slice(0, MAX_RESPONSE_BYTES),
            });
          });
          response.on("error", (error) =>
            answer({ outcome: "unreachable", problem: reasonFor(error) }),
          );
        },
      );

      request.on("timeout", () => {
        request.destroy();
        answer({
          outcome: "unreachable",
          problem: `${url.hostname} did not answer within ${this.timeoutMs}ms`,
        });
      });
      request.on("error", (error) => answer({ outcome: "unreachable", problem: reasonFor(error) }));

      request.end(body);
    });
  }
}

/**
 * Why a status is a refusal rather than an answer, or nothing.
 *
 * **A redirect is never followed**, and this is where that is enforced: the
 * Bank's endpoint answering `302 Location: http://169.254.169.254/` is the
 * cloud-metadata attack with no DNS involved, and a client that helpfully
 * followed it would have done the one thing every check above exists to
 * prevent. Node's own client follows nothing, so this makes the refusal
 * deliberate rather than incidental — and legible in the audit row.
 *
 * A non-2xx that is not a redirect is *the Bank's endpoint saying no*, which is
 * an answer and is reported as one.
 */
export const redirectProblem = (
  status: number,
  location: string | string[] | undefined,
): string | undefined => {
  if (status < 300 || status > 399) return undefined;

  const to = Array.isArray(location) ? location[0] : location;
  return (
    `the endpoint answered ${status} and redirected${to ? ` to ${to}` : ""}. ` +
    "A redirect is never followed: it is how an address that checked out becomes one that did not."
  );
};

const reasonFor = (error: unknown): string =>
  error instanceof Error ? error.message : "the call did not complete";

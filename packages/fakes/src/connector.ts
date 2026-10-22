import { respondJson, startFake, type FakeService } from "./server";

/**
 * **A Bank API somebody registered as a Connector**, and the reason it exists in
 * this package at all.
 *
 * v1 ships with **zero Connectors registered**, so there is nothing real to
 * exercise dispatch against and nothing to measure the Support Agent's selection
 * reliability with. Ticket 18 closed that by making it ours rather than an ask
 * to the Bank: two or three fakes in our own harness.
 *
 * It is an HTTP server rather than a mocked class for the same reason every
 * other fake here is one. What the tests need to see is the **request** — that
 * the envelope is a `POST` with a JSON body, that the credential arrived in the
 * header the Bank named, and above all that `account_number` is the one the
 * Binding resolved to rather than anything a model produced.
 */

export interface FakeConnectorOptions {
  /** What it answers with. Changed mid-test with `setAnswer`. */
  readonly status?: number;
  readonly body?: unknown;
}

/** One call, as the Bank's endpoint received it. */
export interface FakeConnectorCall {
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  /** The envelope: ours, with the Bank's own field names inside `parameters`. */
  readonly body: {
    readonly connector?: string;
    readonly account_number?: string;
    readonly gated?: boolean;
    readonly parameters?: Readonly<Record<string, unknown>>;
  };
}

export interface FakeConnector extends FakeService {
  readonly calls: readonly FakeConnectorCall[];
  readonly setAnswer: (answer: { status: number; body: unknown }) => void;
}

export const startFakeConnector = async (
  options: FakeConnectorOptions = {},
): Promise<FakeConnector> => {
  let answer: { status: number; body: unknown } = {
    status: options.status ?? 200,
    body: options.body ?? { ok: true },
  };

  const service = await startFake((request, response) => {
    respondJson(response, answer.status, answer.body);
  });

  return {
    ...service,
    get calls() {
      return service.requests.map(
        (request): FakeConnectorCall => ({
          method: request.method,
          headers: request.headers,
          body: (request.body ?? {}) as FakeConnectorCall["body"],
        }),
      );
    },
    setAnswer: (next) => {
      answer = next;
    },
  };
};

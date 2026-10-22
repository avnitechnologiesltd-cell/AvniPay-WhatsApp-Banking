import { loadDashboardConfig } from "@avni/config";

/**
 * The one way the Dashboard talks to the Middleware.
 *
 * **Not `middleware.ts`**, which is a reserved filename: Next reads
 * `src/middleware.ts` as *its* middleware and compiles it for the edge runtime,
 * which drags `instrumentation.ts` in with it and fails the build on `node:fs`.
 * The name is unfortunate — this is the only file in the repository that cannot
 * be called after the thing it is about — and it is recorded here because the
 * error it produces names neither file.
 *
 * Never to Postgres directly, and the reason is the same one that put the audit
 * log's read path there: the Middleware owns the write path, so a compromised
 * Dashboard cannot quietly stop recording itself — and it owns the read path
 * too, so there is exactly one place the authentication boundary and the audit
 * row live.
 *
 * **Every call needs a session token, and every one of them leaves a row.**
 *
 * The types each surface deals in are declared beside that surface rather than
 * imported from `@avni/middleware`, on purpose. The Dashboard is a separate
 * deployable talking over HTTP, and a shared type would make a wire contract
 * look like a function call — the journey tests drive the real endpoints and are
 * what keep the two honest.
 */

/** The signed-in Officer, and where the Middleware is. */
export interface Session {
  /** The Officer's session token. **Required** — none of this is public. */
  readonly token: string;
  /** Injectable so a test can point this at a Middleware it started. */
  readonly middlewareBaseUrl?: string;
}

/**
 * The Middleware declined, with the status it declined at.
 *
 * A class rather than a bare `Error` so a page can tell *"sign in again"* from
 * *"your role does not allow that"* without matching on a message — the two send
 * an Officer to two different places.
 *
 * `problem` carries the Middleware's own sentence where it sent one. That
 * matters on the Settings screen and nowhere else so far: an Administrator who
 * typed a closing time before an opening time should be told which field, and
 * *"HTTP 400"* is not that.
 */
export class MiddlewareRefused extends Error {
  public constructor(
    public readonly status: number,
    what: string,
    public readonly problem?: string,
  ) {
    super(`The Middleware declined ${what}: HTTP ${status}${problem ? ` — ${problem}` : ""}`);
    this.name = "MiddlewareRefused";
  }
}

export const middlewareUrl = (session: Session): string =>
  (session.middlewareBaseUrl ?? loadDashboardConfig().middlewareBaseUrl).replace(/\/+$/, "");

/**
 * One request, and the one refusal shape.
 *
 * Every path is encoded by its caller on the way in, because all of it came off
 * a form somebody typed into. The Middleware validates anyway; that is the belt
 * to this pair of braces and it costs nothing.
 */
export const ask = async <T>(
  session: Session,
  route: string,
  what: string,
  options: { method?: "GET" | "POST" | "PUT"; body?: unknown } = {},
): Promise<T> => {
  const method = options.method ?? "GET";

  const response = await fetch(`${middlewareUrl(session)}${route}`, {
    method,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${session.token}`,
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) throw new MiddlewareRefused(response.status, what, await problemIn(response));
  return (await response.json()) as T;
};

/**
 * Nest's exception filter answers `{ message, error, statusCode }`. The message
 * is the sentence the endpoint wrote, and it is the whole reason a refusal on
 * this surface is worth reading rather than just counting.
 */
const problemIn = async (response: Response): Promise<string | undefined> => {
  const body = await response.text().catch(() => "");
  if (!body) return undefined;

  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    if (typeof parsed.message === "string") return parsed.message;
    if (Array.isArray(parsed.message)) return parsed.message.join("; ");
  } catch {
    // Not JSON. The raw body is still better than nothing.
  }
  return body.slice(0, 500);
};

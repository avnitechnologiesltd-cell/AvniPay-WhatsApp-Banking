import { loadDashboardConfig } from "@avni/config";

/**
 * The Dashboard reads the audit log **through the Middleware**, never from
 * Postgres directly.
 *
 * That is the whole point of the arrangement: the Middleware owns the write
 * path, so a compromised Dashboard cannot quietly stop recording itself — and
 * it owns the read path too, so there is exactly one place to put the
 * authentication boundary ticket 28 will add.
 *
 * **The caller must be signed in.** The Middleware refuses without a session,
 * checks the `audit.read` capability, and records the read — including which
 * Customer was looked for. Reading who looked at whose money is itself the
 * sensitive act here, so it is audited like any other.
 *
 * Not yet wired to a page: the screens arrive with
 * ticket 37.
 */

export interface AuditEntry {
  readonly id: string;
  readonly recordedAt: string;
  readonly action: string;
  readonly actorKind: string;
  readonly actorId: string | null;
  readonly accountNumber: string | null;
  readonly conversationId: string | null;
  readonly requestId: string | null;
  readonly outcome: string;
  readonly detail: Readonly<Record<string, unknown>>;
}

export interface ReadAuditOptions {
  /** The signed-in Officer's session token. Required. */
  readonly token: string;
  readonly accountNumber?: string;
  readonly conversationId?: string;
  readonly action?: string;
  /**
   * Narrowed **server-side**, because the limit is applied before a caller could
   * filter. A page that read the last twenty rows and kept the successful ones
   * would report *"never changed"* on an action with twenty recent refusals.
   */
  readonly outcome?: "succeeded" | "refused" | "failed" | "unavailable";
  readonly before?: string;
  readonly limit?: number;
  /** Injectable so a test can point this at a Middleware it started. */
  readonly middlewareBaseUrl?: string;
}

export const readAuditEntries = async (
  options: ReadAuditOptions,
): Promise<readonly AuditEntry[]> => {
  const baseUrl = options.middlewareBaseUrl ?? loadDashboardConfig().middlewareBaseUrl;
  const url = new URL(`${baseUrl.replace(/\/+$/, "")}/dashboard/audit`);

  for (const [key, value] of Object.entries({
    accountNumber: options.accountNumber,
    conversationId: options.conversationId,
    action: options.action,
    outcome: options.outcome,
    before: options.before,
    limit: options.limit?.toString(),
  })) {
    if (value !== undefined) url.searchParams.set(key, value);
  }

  const response = await fetch(url, {
    headers: { accept: "application/json", authorization: `Bearer ${options.token}` },
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    throw new Error(`The Middleware declined the audit read: HTTP ${response.status}`);
  }

  const body = (await response.json()) as { entries?: AuditEntry[] };
  return body.entries ?? [];
};

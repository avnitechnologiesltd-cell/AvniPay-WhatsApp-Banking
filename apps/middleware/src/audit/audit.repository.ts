import { Inject, Injectable, Logger } from "@nestjs/common";

import type { Pool } from "@avni/db";
import { DATABASE_POOL } from "@avni/service";

import {
  FORBIDDEN_DETAIL_KEYS,
  type AuditEntry,
  type AuditOutcome,
  type AuditRecord,
  type ActorKind,
} from "./actions";

/** What a reader may narrow by. Everything is optional; nothing is required. */
export interface AuditQuery {
  readonly accountNumber?: string;
  readonly conversationId?: string;
  readonly action?: string;
  /**
   * `succeeded`, `refused`, `failed` or `unavailable`.
   *
   * Here rather than left to the caller to filter afterwards, because the limit
   * is applied **before** any filtering a caller could do: twenty refused
   * attempts at one action would otherwise push every successful one off the
   * page, and a screen showing the last twenty rows would report that nothing
   * had ever happened.
   */
  readonly outcome?: string;
  readonly limit?: number;
  /** Page backwards from an id, since ids are monotonic. */
  readonly before?: string;
}

interface AuditRow {
  id: string;
  recorded_at: Date;
  action: string;
  actor_kind: ActorKind;
  actor_id: string | null;
  account_number: string | null;
  conversation_id: string | null;
  request_id: string | null;
  outcome: AuditOutcome;
  detail: Record<string, unknown>;
}

const COLUMNS =
  "id::text, recorded_at, action, actor_kind, actor_id, account_number, conversation_id::text, request_id, outcome, detail";

const toEntry = (row: AuditRow): AuditEntry => ({
  id: row.id,
  recordedAt: row.recorded_at,
  action: row.action,
  actorKind: row.actor_kind,
  actorId: row.actor_id,
  accountNumber: row.account_number,
  conversationId: row.conversation_id,
  requestId: row.request_id,
  outcome: row.outcome,
  detail: row.detail ?? {},
});

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/**
 * The audit log's only write path, and it lives in the Middleware.
 *
 * **There is no delete method, and there will not be one.** The platform never
 * removes a row; retention and archival are the Bank's, and
 * `AUDIT_RETENTION_DAYS` records that policy rather than enacting it. A guard
 * test refuses any `delete from audit_entries` appearing in the workspace,
 * because the moment this class grows a `prune()` the table stops being
 * evidence and becomes a cache.
 */
@Injectable()
export class AuditRepository {
  private readonly logger = new Logger(AuditRepository.name);

  public constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  /**
   * Records one thing that happened.
   *
   * **Never throws.** A failed write goes to stdout and the caller carries on:
   * an audit table that can stop a Customer reading their balance is an
   * availability risk wearing a compliance costume, and the operational log is
   * the fallback of record for exactly this case.
   */
  public async record(entry: AuditRecord): Promise<void> {
    try {
      await this.pool.query(
        `insert into audit_entries
           (action, actor_kind, actor_id, account_number, conversation_id, request_id, outcome, detail)
         values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
        [
          entry.action,
          entry.actor.kind,
          entry.actor.id ?? null,
          entry.accountNumber ?? null,
          entry.conversationId ?? null,
          entry.requestId ?? null,
          entry.outcome,
          JSON.stringify(scrub(entry.detail ?? {})),
        ],
      );
    } catch (error) {
      this.logger.error({
        event: "audit_write_failed",
        action: entry.action,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Newest first, because an investigation starts from what just happened. */
  public async read(query: AuditQuery = {}): Promise<readonly AuditEntry[]> {
    const wheres: string[] = [];
    const values: unknown[] = [];

    const narrow = (clause: string, value: unknown): void => {
      values.push(value);
      wheres.push(clause.replace("$?", `$${values.length}`));
    };

    if (query.accountNumber) narrow("account_number = $?", query.accountNumber);
    if (query.conversationId && UUID.test(query.conversationId)) {
      narrow("conversation_id = $?", query.conversationId);
    } else if (query.conversationId) {
      // A malformed id is a filter that matches nothing, not a crash.
      return [];
    }
    if (query.action) narrow("action = $?", query.action);
    if (query.outcome) narrow("outcome = $?", query.outcome);
    if (query.before) narrow("id < $?", query.before);

    const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const where = wheres.length > 0 ? `where ${wheres.join(" and ")}` : "";

    const { rows } = await this.pool.query<AuditRow>(
      // **`audit_entries.id`, qualified, and the qualification is load-bearing.**
      // `COLUMNS` selects `id::text`, which produces an *output* column also
      // called `id` — and a bare `order by id` binds to the output column in
      // preference to the input one, so it sorted the Bank's security record as
      // **text**. That reads correctly until the table holds ten rows, and then
      // `"9"` sorts above `"10"` forever. Qualifying the name makes it an
      // expression over the column, which is the `bigserial` this ordering was
      // always supposed to be.
      `select ${COLUMNS} from audit_entries ${where} order by audit_entries.id desc limit ${limit}`,
      values,
    );
    return rows.map(toEntry);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Drops anything that looks like a secret before it is written.
 *
 * Checked here rather than trusted to callers, because the audit table is the
 * one place the Bank will look during an investigation, which makes it the
 * worst possible place to accumulate PINs and response bodies.
 */
const scrub = (detail: Readonly<Record<string, unknown>>): Record<string, unknown> => {
  const clean: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(detail)) {
    const normalised = key.toLowerCase().replace(/[^a-z]/g, "");
    if (FORBIDDEN_DETAIL_KEYS.includes(normalised as never)) {
      clean[key] = "[redacted]";
      continue;
    }
    clean[key] =
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? scrub(value as Record<string, unknown>)
        : value;
  }

  return clean;
};

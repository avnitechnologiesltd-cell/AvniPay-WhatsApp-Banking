import { createHash, randomBytes } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";

import type { Pool } from "@avni/db";
import { CLOCK, DATABASE_POOL, type Clock } from "@avni/service";

import type { OtpPurpose } from "./bank-identity.client";

/**
 * Enrollments in flight, and the attempt counter that outlives them.
 *
 * Two tables, and the split between them is the point. A **session** is one walk
 * through the Flow and dies with it. The **lockout** belongs to the WhatsApp
 * number and survives the Flow being closed and reopened — a counter that reset
 * when the Customer started again would make the silent enumeration walk free,
 * which is the same mistake as counting PIN attempts against a single transfer.
 */

export type EnrollmentPhase =
  | "identifying"
  | "choosing_destination"
  | "awaiting_code"
  | "setting_pin"
  | "complete";

export interface EnrollmentSession {
  readonly id: string;
  readonly channelIdentity: string;
  readonly purpose: OtpPurpose;
  readonly accountNumber: string | null;
  /**
   * Whether the Bank holds this account. **Never surfaced in any form** — the
   * one place in the system a wrong account number is distinguishable from a
   * wrong code, alongside the audit rows.
   */
  readonly accountExists: boolean;
  readonly destinationId: string | null;
  readonly bindingId: string | null;
  readonly phase: EnrollmentPhase;
  readonly startedAt: Date;
}

interface SessionRow {
  id: string;
  channel_identity: string;
  purpose: OtpPurpose;
  account_number: string | null;
  account_exists: boolean;
  destination_id: string | null;
  binding_id: string | null;
  phase: EnrollmentPhase;
  started_at: Date;
}

const COLUMNS =
  "id, channel_identity, purpose, account_number, account_exists, destination_id, binding_id, phase, started_at";

const toSession = (row: SessionRow): EnrollmentSession => ({
  id: row.id,
  channelIdentity: row.channel_identity,
  purpose: row.purpose,
  accountNumber: row.account_number,
  accountExists: row.account_exists,
  destinationId: row.destination_id,
  bindingId: row.binding_id,
  phase: row.phase,
  startedAt: row.started_at,
});

/** The Flow token is a bearer credential, so only its hash is stored. */
const hashToken = (token: string): string =>
  createHash("sha256").update(token, "utf8").digest("hex");

export interface StartedEnrollment {
  /** Handed to the handset inside the Flow. Never stored, never logged. */
  readonly token: string;
  readonly session: EnrollmentSession;
}

export interface Lockout {
  readonly failedAttempts: number;
  readonly lockedUntil: Date | null;
}

@Injectable()
export class EnrollmentRepository {
  public constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  public async start(
    channelIdentity: string,
    purpose: OtpPurpose,
    from: { readonly accountNumber?: string; readonly bindingId?: string } = {},
  ): Promise<StartedEnrollment> {
    const token = randomBytes(32).toString("base64url");
    const phase: EnrollmentPhase =
      purpose === "enrollment" ? "identifying" : "choosing_destination";

    const { rows } = await this.pool.query<SessionRow>(
      `insert into enrollments
         (token_hash, channel_identity, purpose, account_number, account_exists, binding_id, phase, started_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       returning ${COLUMNS}`,
      [
        hashToken(token),
        channelIdentity,
        purpose,
        from.accountNumber ?? null,
        // A renewal or a PIN reset identifies from an existing Binding rather
        // than from something typed, so the account is real until the Bank says
        // otherwise — which it may, if the account has since been closed.
        from.accountNumber !== undefined,
        from.bindingId ?? null,
        phase,
        this.clock.now(),
      ],
    );

    return { token, session: toSession(rows[0] as SessionRow) };
  }

  public async findByToken(token: string | undefined): Promise<EnrollmentSession | undefined> {
    if (!token) return undefined;

    const { rows } = await this.pool.query<SessionRow>(
      `select ${COLUMNS} from enrollments where token_hash = $1`,
      [hashToken(token)],
    );
    return rows[0] ? toSession(rows[0]) : undefined;
  }

  public async update(
    id: string,
    changes: {
      readonly accountNumber?: string;
      readonly accountExists?: boolean;
      readonly destinationId?: string;
      readonly phase?: EnrollmentPhase;
    },
  ): Promise<void> {
    await this.pool.query(
      `update enrollments set
         account_number  = coalesce($2, account_number),
         account_exists  = coalesce($3, account_exists),
         destination_id  = coalesce($4, destination_id),
         phase           = coalesce($5, phase)
       where id = $1`,
      [
        id,
        changes.accountNumber ?? null,
        changes.accountExists ?? null,
        changes.destinationId ?? null,
        changes.phase ?? null,
      ],
    );
  }

  public async complete(id: string): Promise<void> {
    await this.pool.query(
      "update enrollments set phase = 'complete', completed_at = now() where id = $1",
      [id],
    );
  }

  // --- The lockout, which belongs to the number rather than to the walk ------

  public async lockoutFor(channelIdentity: string): Promise<Lockout> {
    const { rows } = await this.pool.query<{ failed_attempts: number; locked_until: Date | null }>(
      "select failed_attempts, locked_until from enrollment_lockouts where channel_identity = $1",
      [channelIdentity],
    );
    const row = rows[0];
    return {
      failedAttempts: row?.failed_attempts ?? 0,
      lockedUntil: row?.locked_until ?? null,
    };
  }

  /** Records one failed code, and returns how many have now been spent. */
  public async recordFailure(
    channelIdentity: string,
    spentBefore: number,
    lockUntil: Date | null,
  ): Promise<number> {
    const spent = spentBefore + 1;
    await this.pool.query(
      `insert into enrollment_lockouts (channel_identity, failed_attempts, locked_until)
       values ($1, $2, $3)
       on conflict (channel_identity) do update
         set failed_attempts = excluded.failed_attempts,
             locked_until = excluded.locked_until,
             updated_at = now()`,
      [channelIdentity, spent, lockUntil],
    );
    return spent;
  }

  public async clearFailures(channelIdentity: string): Promise<void> {
    await this.pool.query(
      `insert into enrollment_lockouts (channel_identity, failed_attempts, locked_until)
       values ($1, 0, null)
       on conflict (channel_identity) do update
         set failed_attempts = 0, locked_until = null, updated_at = now()`,
      [channelIdentity],
    );
  }
}

import { Inject, Injectable } from "@nestjs/common";

import type { Pool } from "@avni/db";
import { CLOCK, DATABASE_POOL, type Clock } from "@avni/service";

import { AuditRepository } from "../audit/audit.repository";
import { hashSecret, verifySecret } from "../secrets/argon2";
import { PIN_ATTEMPTS, PIN_LOCKOUT_MS } from "./transaction-pin";

/**
 * Where the Transaction PIN lives, and the counter that is its real defence.
 *
 * **In the Middleware and never in the Platform** — the Platform reads Customer
 * text into an LLM on every message, and a security record inside that surface
 * is what [ADR-0006](../../../../docs/adr/0006-secrets-and-security-records-live-outside-the-platform.md)
 * exists to prevent. The PIN reaches here only through a sealed surface that
 * terminates at the Middleware ([ADR-0007](../../../../docs/adr/0007-flow-confirmations-terminate-at-the-middleware.md)),
 * so it is never a value the Platform holds even in flight.
 *
 * Keyed on the **account**, which is what makes the lockout count against the
 * Customer rather than against any single transfer, and what lets a PIN survive
 * a Customer changing handset.
 */

export type PinCheck =
  | { readonly outcome: "verified" }
  | { readonly outcome: "wrong"; readonly attemptsLeft: number }
  | { readonly outcome: "locked_out"; readonly until: Date }
  /** No PIN has ever been set for this account. */
  | { readonly outcome: "not_set" };

interface PinRow {
  pin_hash: string;
  failed_attempts: number;
  locked_until: Date | null;
}

/**
 * A hash of a PIN nobody chose, so a check against an account with no PIN still
 * pays the full argon2id cost. Cheap, and it keeps one more thing off the list
 * of questions a stopwatch can answer.
 */
let decoyHash: string | undefined;

@Injectable()
export class TransactionPinService {
  public constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    @Inject(AuditRepository) private readonly audit: AuditRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Sets or replaces the PIN, and clears the lockout with it.
   *
   * Both callers reach here having just passed a code sent to the contact
   * already on record — the last step of enrollment, and a forgotten-PIN reset
   * over that same path. That is deliberately the *only* way in: no Support
   * Officer sets a PIN, and there is no second mechanism to keep honest.
   */
  public async set(
    accountNumber: string,
    pin: string,
    detail: Readonly<Record<string, unknown>> = {},
  ): Promise<void> {
    const pinHash = await hashSecret(pin);

    await this.pool.query(
      `insert into transaction_pins (account_number, pin_hash)
       values ($1, $2)
       on conflict (account_number) do update
         set pin_hash = excluded.pin_hash,
             updated_at = now(),
             failed_attempts = 0,
             locked_until = null`,
      [accountNumber, pinHash],
    );

    await this.audit.record({
      action: "pin.set",
      actor: { kind: "customer" },
      outcome: "succeeded",
      accountNumber,
      detail,
    });
  }

  public async isSet(accountNumber: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      "select 1 from transaction_pins where account_number = $1",
      [accountNumber],
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * Checks a PIN, and spends one of three attempts if it is wrong.
   *
   * Nothing here is called yet — the surfaces that take a PIN are the transfer
   * Confirmation screen (ticket 31) and Gated Connector dispatch (ticket 40).
   * The counter is built now rather than then because it is *shared* between
   * them, and a second one added later beside the first is the exact failure
   * ADR-0009 spent a paragraph refusing.
   */
  public async verify(
    accountNumber: string,
    pin: string,
    context: { readonly conversationId?: string } = {},
  ): Promise<PinCheck> {
    const now = this.clock.now();
    const { rows } = await this.pool.query<PinRow>(
      "select pin_hash, failed_attempts, locked_until from transaction_pins where account_number = $1",
      [accountNumber],
    );
    const row = rows[0];

    if (!row) {
      await verifySecret(await this.decoy(), pin);
      await this.record(accountNumber, "refused", context, { reason: "no PIN is set" });
      return { outcome: "not_set" };
    }

    if (row.locked_until && row.locked_until > now) {
      // Refused before the hash is even computed. A locked account is not a
      // slower guess, it is no guess at all.
      await this.record(accountNumber, "refused", context, { reason: "locked out" });
      return { outcome: "locked_out", until: row.locked_until };
    }

    // A lockout that has run out takes the failure count with it. Leaving the
    // count behind would make the fourth wrong PIN of a Customer's life lock
    // them out as if it were the third.
    const spent = row.locked_until && row.locked_until <= now ? 0 : row.failed_attempts;

    if (await verifySecret(row.pin_hash, pin)) {
      await this.pool.query(
        "update transaction_pins set failed_attempts = 0, locked_until = null where account_number = $1",
        [accountNumber],
      );
      await this.record(accountNumber, "succeeded", context);
      return { outcome: "verified" };
    }

    const used = spent + 1;
    if (used >= PIN_ATTEMPTS) {
      const until = new Date(now.getTime() + PIN_LOCKOUT_MS);
      await this.pool.query(
        "update transaction_pins set failed_attempts = $2, locked_until = $3 where account_number = $1",
        [accountNumber, used, until],
      );
      await this.audit.record({
        action: "pin.locked_out",
        actor: { kind: "customer" },
        outcome: "refused",
        accountNumber,
        ...(context.conversationId ? { conversationId: context.conversationId } : {}),
        detail: { attempts: used, untilMinutes: PIN_LOCKOUT_MS / 60_000 },
      });
      return { outcome: "locked_out", until };
    }

    await this.pool.query(
      "update transaction_pins set failed_attempts = $2, locked_until = null where account_number = $1",
      [accountNumber, used],
    );
    await this.record(accountNumber, "refused", context, { attemptsLeft: PIN_ATTEMPTS - used });
    return { outcome: "wrong", attemptsLeft: PIN_ATTEMPTS - used };
  }

  private async record(
    accountNumber: string,
    outcome: "succeeded" | "refused",
    context: { readonly conversationId?: string },
    detail: Readonly<Record<string, unknown>> = {},
  ): Promise<void> {
    await this.audit.record({
      action: "pin.checked",
      actor: { kind: "customer" },
      outcome,
      accountNumber,
      ...(context.conversationId ? { conversationId: context.conversationId } : {}),
      detail,
    });
  }

  private async decoy(): Promise<string> {
    decoyHash ??= await hashSecret("0000");
    return decoyHash;
  }
}

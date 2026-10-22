import { Inject, Injectable } from "@nestjs/common";

import type { Pool } from "@avni/db";
import { CLOCK, DATABASE_POOL, type Clock } from "@avni/service";

import type { Actor } from "../audit/actions";
import { AuditRepository } from "../audit/audit.repository";

/**
 * The **Binding** — the record linking a channel identity to a single bank
 * account. Created by enrollment, refreshed by renewal, destroyed by
 * revocation.
 *
 * It lives here and only here. The Platform asks the Middleware "does this
 * conversation reach an account?" and gets back a bit, never the number
 * ([ADR-0006](../../../../docs/adr/0006-secrets-and-security-records-live-outside-the-platform.md)).
 *
 * In-app chat has no Binding at all — the Bank's application states the account
 * on every message, and a Binding exists only to remember what a channel
 * identity cannot say for itself ([ADR-0010](../../../../docs/adr/0010-the-in-app-chat-snippet-carries-a-signed-identity.md)).
 */
export interface Binding {
  readonly id: string;
  readonly channelIdentity: string;
  readonly accountNumber: string;
  readonly enrolledAt: Date;
  readonly renewedAt: Date | null;
  readonly revokedAt: Date | null;
  /**
   * When the Customer last spoke to us **of their own accord**. Messages we send
   * never move it: a notification to an already-recycled number that refreshed
   * the Binding would keep alive precisely what dormancy exists to kill.
   */
  readonly lastActivityAt: Date;
}

interface BindingRow {
  id: string;
  channel_identity: string;
  account_number: string;
  enrolled_at: Date;
  renewed_at: Date | null;
  revoked_at: Date | null;
  last_activity_at: Date;
}

const toBinding = (row: BindingRow): Binding => ({
  id: row.id,
  channelIdentity: row.channel_identity,
  accountNumber: row.account_number,
  enrolledAt: row.enrolled_at,
  renewedAt: row.renewed_at,
  revokedAt: row.revoked_at,
  lastActivityAt: row.last_activity_at,
});

const COLUMNS =
  "id, channel_identity, account_number, enrolled_at, renewed_at, revoked_at, last_activity_at";

const DAY_MS = 24 * 60 * 60 * 1000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether a Binding has gone quiet for long enough to need renewing.
 *
 * **Expiry is on inactivity, not on the calendar.** Nigerian operators only
 * recycle a number after prolonged dormancy, so a Binding on a number in regular
 * use is itself evidence the number has not changed hands. Challenging on the
 * calendar interrupts the Customers least at risk; challenging on silence
 * interrupts only the ones who might be.
 */
export const isDormant = (binding: Binding, now: Date, dormancyDays: number): boolean =>
  now.getTime() - binding.lastActivityAt.getTime() >= dormancyDays * DAY_MS;

/** What `bind` displaced. Each one needs telling, which is the caller's job. */
export interface BindResult {
  readonly created: Binding;
  readonly revoked: readonly Binding[];
}

@Injectable()
export class BindingsRepository {
  /**
   * The clock is injected here and not merely in the reader.
   *
   * `last_activity_at` is compared against it to decide dormancy, so the value
   * written and the value compared have to come from the same place. Stamping
   * the row with Postgres's `now()` and judging it against an injected clock is
   * two clocks disagreeing, which reads as a rule that almost works.
   */
  public constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    @Inject(AuditRepository) private readonly audit: AuditRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * The unrevoked Binding for a channel identity, dormant or not.
   *
   * Renewal needs the dormant ones — that is what it renews — so dormancy is a
   * question asked of the record rather than a filter applied to the query.
   */
  public async findLiveByChannelIdentity(channelIdentity: string): Promise<Binding | undefined> {
    const { rows } = await this.pool.query<BindingRow>(
      `select ${COLUMNS} from bindings where channel_identity = $1 and revoked_at is null`,
      [channelIdentity],
    );
    return rows[0] ? toBinding(rows[0]) : undefined;
  }

  /**
   * One Binding by id.
   *
   * **A malformed id is a miss, not a crash.** The id column is a `uuid`, so
   * anything else makes Postgres throw rather than answer — and this is reached
   * from a Dashboard path segment, where a mistyped or invented id is an
   * ordinary thing to receive. The same rule the Beneficiary store already
   * holds, for the same reason.
   */
  public async findById(id: string): Promise<Binding | undefined> {
    if (!UUID.test(id)) return undefined;

    const { rows } = await this.pool.query<BindingRow>(
      `select ${COLUMNS} from bindings where id = $1`,
      [id],
    );
    return rows[0] ? toBinding(rows[0]) : undefined;
  }

  /**
   * Every Binding an account has ever had, newest first — **revoked ones
   * included**.
   *
   * For the Dashboard's Customers surface, where the revoked ones are half the
   * answer: *"my WhatsApp stopped working"* is a Customer describing a Binding
   * that was displaced when the account was enrolled somewhere else, and a list
   * showing only the live one leaves an Officer with nothing to say about it.
   */
  public async findAllForAccount(accountNumber: string): Promise<readonly Binding[]> {
    const { rows } = await this.pool.query<BindingRow>(
      `select ${COLUMNS} from bindings
       where account_number = $1
       order by revoked_at is not null, enrolled_at desc`,
      [accountNumber],
    );
    return rows.map(toBinding);
  }

  /**
   * Every Binding a channel identity has ever had, newest first.
   *
   * The revoked ones are what make a search by phone number answer at all for a
   * Customer who has re-enrolled: one number, two accounts over time, and the
   * Officer needs both.
   */
  public async findAllByChannelIdentity(channelIdentity: string): Promise<readonly Binding[]> {
    const { rows } = await this.pool.query<BindingRow>(
      `select ${COLUMNS} from bindings
       where channel_identity = $1
       order by revoked_at is not null, enrolled_at desc`,
      [channelIdentity],
    );
    return rows.map(toBinding);
  }

  /**
   * Binds a channel identity to an account, revoking whatever either of them was
   * previously bound to, and — when enrollment supplies one — writing the
   * Transaction PIN in the same transaction.
   *
   * **The PIN travels with the Binding on purpose.** A Binding with no PIN can
   * read a balance and authorise nothing, so a Customer holding one is not
   * linked in any sense they would recognise. Writing both or neither is what
   * makes "you are linked" a true sentence rather than an optimistic one.
   *
   * The auto-revoke is the other half. A Customer whose phone was stolen must be
   * able to enroll on a new number and have the old Binding die in minutes
   * rather than in ninety days, and one live Binding per account is what does
   * that. The displaced Bindings come back so the caller can tell their owners.
   */
  public async bind(
    channelIdentity: string,
    accountNumber: string,
    options: { readonly pinHash?: string } = {},
  ): Promise<BindResult> {
    const now = this.clock.now();
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const { rows: revokedRows } = await client.query<BindingRow>(
        `update bindings set revoked_at = $3
         where revoked_at is null and (channel_identity = $1 or account_number = $2)
         returning ${COLUMNS}`,
        [channelIdentity, accountNumber, now],
      );
      const { rows } = await client.query<BindingRow>(
        `insert into bindings (channel_identity, account_number, enrolled_at, last_activity_at)
         values ($1, $2, $3, $3) returning ${COLUMNS}`,
        [channelIdentity, accountNumber, now],
      );

      if (options.pinHash) {
        await client.query(
          `insert into transaction_pins (account_number, pin_hash)
           values ($1, $2)
           on conflict (account_number) do update
             set pin_hash = excluded.pin_hash,
                 updated_at = now(),
                 failed_attempts = 0,
                 locked_until = null`,
          [accountNumber, options.pinHash],
        );
      }

      await client.query("commit");
      const created = toBinding(rows[0] as BindingRow);
      const revoked = revokedRows.map(toBinding);

      // A Binding's whole lifecycle is a security event. A takeover the
      // Customer did not perform is reconstructed from exactly these rows.
      for (const displaced of revoked) {
        await this.audit.record({
          action: "binding.revoked",
          actor: { kind: "system" },
          outcome: "succeeded",
          accountNumber: displaced.accountNumber,
          detail: {
            bindingId: displaced.id,
            reason:
              displaced.channelIdentity === channelIdentity
                ? "this channel identity was bound to another account"
                : "this account was enrolled on another channel identity",
          },
        });
      }
      await this.audit.record({
        action: "binding.created",
        actor: { kind: "system" },
        outcome: "succeeded",
        accountNumber: created.accountNumber,
        detail: { bindingId: created.id, revoked: revoked.length, pinSet: Boolean(options.pinHash) },
      });

      return { created, revoked };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Renewal: the same number, the same account, the clock reset.
   *
   * **It does not touch the Transaction PIN.** A renewal proves the number still
   * belongs to the same person; it says nothing about the PIN, and forcing a new
   * one every ninety days would push Customers toward writing it down.
   */
  public async renew(id: string): Promise<void> {
    const { rows } = await this.pool.query<BindingRow>(
      `update bindings set renewed_at = $2, last_activity_at = $2
       where id = $1 and revoked_at is null
       returning ${COLUMNS}`,
      [id, this.clock.now()],
    );
    const renewed = rows[0];
    if (!renewed) return;

    await this.audit.record({
      action: "binding.renewed",
      actor: { kind: "customer" },
      outcome: "succeeded",
      accountNumber: renewed.account_number,
      detail: { bindingId: renewed.id },
    });
  }

  /**
   * Marks Customer-initiated contact against the Binding a conversation reaches.
   *
   * One statement, and it takes a conversation rather than a Binding, so no
   * caller can reach this with an outbound message in hand.
   *
   * **A Binding that has already gone dormant is never refreshed by it.** That
   * is the case this rule exists for: the number was recycled, somebody else now
   * holds it, and their first message must not quietly restore the access that
   * ninety days of silence took away. Only a code to the contact on record does
   * that.
   */
  public async noteActivityForConversation(
    conversationId: string,
    dormantOnOrBefore: Date,
  ): Promise<void> {
    await this.pool.query(
      `update bindings set last_activity_at = $2
       where revoked_at is null
         and last_activity_at > $3
         and channel_identity = (select channel_identity from conversations where id = $1)`,
      [conversationId, this.clock.now(), dormantOnOrBefore],
    );
  }

  /**
   * @param reason Why, in the audit row. It has a default rather than being
   * required because *"revoked directly"* is the honest answer for the paths
   * that have nothing more to say — but the Dashboard does have more to say,
   * and a Binding a member of staff destroyed must not be indistinguishable in
   * the table from one a Customer unlinked themselves.
   *
   * @returns whether a live Binding was found and destroyed. `false` means it
   * was already revoked, or was never there.
   */
  public async revoke(
    id: string,
    actor: Actor = { kind: "system" },
    reason = "revoked directly",
  ): Promise<boolean> {
    const { rows } = await this.pool.query<BindingRow>(
      `update bindings set revoked_at = $2 where id = $1 and revoked_at is null returning ${COLUMNS}`,
      [id, this.clock.now()],
    );
    const revoked = rows[0];
    if (!revoked) return false;

    await this.audit.record({
      action: "binding.revoked",
      actor,
      outcome: "succeeded",
      accountNumber: revoked.account_number,
      detail: { bindingId: revoked.id, reason },
    });
    return true;
  }
}

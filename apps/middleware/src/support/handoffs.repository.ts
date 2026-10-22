import { Inject, Injectable } from "@nestjs/common";

import type { Pool } from "@avni/db";
import { DATABASE_POOL } from "@avni/service";

import { urgencyOf, type HandoffTrigger } from "./handoff";

/**
 * The Inbox, as rows.
 *
 * **A claim is exclusive, and it is exclusive because of a `where` clause.**
 * Two Officers opening the same conversation and both pressing *claim* is the
 * ordinary Monday-morning case, not an exotic race, and a read-then-write in
 * application code loses it. The conditional update below either affects one row
 * or none, and "none" is the second Officer being told somebody got there first.
 *
 * Claim **expiry** is computed in the same statement rather than swept by a
 * background job. A job that has not run yet is a lock that has not expired yet,
 * and the person waiting for it is the Customer.
 */

export interface Handoff {
  readonly id: string;
  readonly conversationId: string;
  readonly trigger: HandoffTrigger;
  readonly summary: string;
  readonly raisedAt: Date;
  readonly claimedBy: string | null;
  readonly claimedAt: Date | null;
  readonly officerLastActiveAt: Date | null;
  readonly resolvedAt: Date | null;
  readonly resolvedBy: string | null;
}

interface HandoffRow {
  id: string;
  conversation_id: string;
  trigger: HandoffTrigger;
  summary: string;
  raised_at: Date;
  claimed_by: string | null;
  claimed_at: Date | null;
  officer_last_active_at: Date | null;
  resolved_at: Date | null;
  resolved_by: string | null;
}

const COLUMNS =
  "id::text, conversation_id::text, trigger, summary, raised_at, claimed_by::text, " +
  "claimed_at, officer_last_active_at, resolved_at, resolved_by::text";

/** The same list, for the one read that joins. Kept beside it so they agree. */
const ALIASED_COLUMNS = COLUMNS.split(", ")
  .map((column) => `h.${column}`)
  .join(", ");

const toHandoff = (row: HandoffRow): Handoff => ({
  id: row.id,
  conversationId: row.conversation_id,
  trigger: row.trigger,
  summary: row.summary,
  raisedAt: row.raised_at,
  claimedBy: row.claimed_by,
  claimedAt: row.claimed_at,
  officerLastActiveAt: row.officer_last_active_at,
  resolvedAt: row.resolved_at,
  resolvedBy: row.resolved_by,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class HandoffsRepository {
  public constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  /**
   * Opens a Handoff, or answers the one that is already open.
   *
   * **One open Handoff per conversation**, held by a partial unique index rather
   * than by a check here — a Customer who says *"get me a human"* three times
   * must not summon three, and two triggers firing in the same turn must not put
   * one conversation in the Inbox twice. `on conflict do nothing` then a read is
   * the shape that makes the second caller a no-op instead of an error.
   */
  public async open(
    conversationId: string,
    trigger: HandoffTrigger,
    summary: string,
  ): Promise<{ readonly handoff: Handoff; readonly raised: boolean }> {
    const { rows } = await this.pool.query<HandoffRow>(
      `insert into handoffs (conversation_id, trigger, summary)
       values ($1, $2, $3)
       on conflict do nothing
       returning ${COLUMNS}`,
      [conversationId, trigger, summary],
    );

    const inserted = rows[0];
    if (inserted) return { handoff: toHandoff(inserted), raised: true };

    const existing = await this.openFor(conversationId);
    if (!existing) {
      // The open row was resolved between the insert and the read. Rare, and
      // the honest answer is to try once more rather than to invent a state.
      return this.open(conversationId, trigger, summary);
    }
    return { handoff: existing, raised: false };
  }

  public async openFor(conversationId: string): Promise<Handoff | undefined> {
    if (!UUID.test(conversationId)) return undefined;

    const { rows } = await this.pool.query<HandoffRow>(
      `select ${COLUMNS} from handoffs where conversation_id = $1 and resolved_at is null`,
      [conversationId],
    );
    const row = rows[0];
    return row ? toHandoff(row) : undefined;
  }

  /**
   * The open Handoff on this channel identity, whichever conversation carries
   * it.
   *
   * **What stops a Platform restart handing a Customer back to the bot.** The
   * Platform caches conversation ids in memory, so a restarted process asks for
   * a conversation again — and without this it would be given a fresh one, with
   * no Handoff on it and an Officer still typing into the old one.
   */
  public async openForChannelIdentity(
    channel: string,
    channelIdentity: string,
  ): Promise<Handoff | undefined> {
    const { rows } = await this.pool.query<HandoffRow>(
      `select ${ALIASED_COLUMNS}
         from handoffs h
         join conversations c on c.id = h.conversation_id
        where h.resolved_at is null and c.channel = $1 and c.channel_identity = $2
        order by h.raised_at desc
        limit 1`,
      [channel, channelIdentity],
    );
    const row = rows[0];
    return row ? toHandoff(row) : undefined;
  }

  public async findById(handoffId: string): Promise<Handoff | undefined> {
    if (!UUID.test(handoffId)) return undefined;

    const { rows } = await this.pool.query<HandoffRow>(
      `select ${COLUMNS} from handoffs where id = $1`,
      [handoffId],
    );
    const row = rows[0];
    return row ? toHandoff(row) : undefined;
  }

  /**
   * The Inbox: everything unresolved, urgent first and then oldest first.
   *
   * Ordered in TypeScript rather than in SQL because the urgency order is a
   * product decision that belongs beside the triggers it ranks, not spelled as a
   * `case` expression a reader has to reconstruct it from.
   */
  public async openHandoffs(): Promise<readonly Handoff[]> {
    const { rows } = await this.pool.query<HandoffRow>(
      `select ${COLUMNS} from handoffs where resolved_at is null`,
    );

    return rows
      .map(toHandoff)
      .sort(
        (a, b) =>
          urgencyOf(a.trigger) - urgencyOf(b.trigger) ||
          a.raisedAt.getTime() - b.raisedAt.getTime(),
      );
  }

  /**
   * Claims a conversation for one Officer, exclusively.
   *
   * Succeeds when the Handoff is open **and** either unclaimed or claimed by
   * somebody who has gone quiet past `idleBefore`. That second clause is what
   * "a claim expires on Officer inactivity and the conversation returns to the
   * queue" means at the only layer where it can be true concurrently.
   */
  public async claim(
    handoffId: string,
    officerId: string,
    now: Date,
    idleBefore: Date,
  ): Promise<Handoff | undefined> {
    if (!UUID.test(handoffId)) return undefined;

    const { rows } = await this.pool.query<HandoffRow>(
      `update handoffs
          set claimed_by = $2, claimed_at = $3, officer_last_active_at = $3
        where id = $1
          and resolved_at is null
          and (claimed_by is null or claimed_by = $2 or officer_last_active_at < $4)
        returning ${COLUMNS}`,
      [handoffId, officerId, now, idleBefore],
    );

    const row = rows[0];
    return row ? toHandoff(row) : undefined;
  }

  /**
   * Marks the claiming Officer active, and answers whether they still hold it.
   *
   * Called on every act an Officer performs against a conversation. It is the
   * one thing that keeps a claim alive, which is why it is a write and not a
   * read: an Officer who is reading rather than typing has stopped working the
   * conversation, and that is what the expiry is for.
   */
  public async noteActivity(
    handoffId: string,
    officerId: string,
    now: Date,
    idleBefore: Date,
  ): Promise<Handoff | undefined> {
    if (!UUID.test(handoffId)) return undefined;

    const { rows } = await this.pool.query<HandoffRow>(
      `update handoffs
          set officer_last_active_at = $3
        where id = $1
          and resolved_at is null
          and claimed_by = $2
          and officer_last_active_at >= $4
        returning ${COLUMNS}`,
      [handoffId, officerId, now, idleBefore],
    );

    const row = rows[0];
    return row ? toHandoff(row) : undefined;
  }

  /**
   * The Officer resolves, and ownership goes back to the Agent for the
   * Customer's **next** message.
   *
   * Only the Officer holding a live claim may. There is no mid-conversation
   * handback and no idle auto-return: a Customer part-way through a sentence to
   * a human suddenly getting a bot is the single worst moment to switch.
   */
  public async resolve(
    handoffId: string,
    officerId: string,
    now: Date,
    idleBefore: Date,
  ): Promise<Handoff | undefined> {
    if (!UUID.test(handoffId)) return undefined;

    const { rows } = await this.pool.query<HandoffRow>(
      `update handoffs
          set resolved_at = $3, resolved_by = $2, officer_last_active_at = $3
        where id = $1
          and resolved_at is null
          and claimed_by = $2
          and officer_last_active_at >= $4
        returning ${COLUMNS}`,
      [handoffId, officerId, now, idleBefore],
    );

    const row = rows[0];
    return row ? toHandoff(row) : undefined;
  }
}

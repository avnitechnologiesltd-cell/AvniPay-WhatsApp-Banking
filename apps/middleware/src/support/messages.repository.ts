import { Inject, Injectable } from "@nestjs/common";

import type { Pool } from "@avni/db";
import { DATABASE_POOL } from "@avni/service";

/**
 * The conversation history an Officer is handed.
 *
 * **`said`, `chose` and `event`, not a flat transcript** (ticket 11) — so an
 * Officer can tell what a Customer *typed* from what they *tapped*, which
 * matters most in the case they will actually be called about, where somebody
 * paid the wrong person.
 *
 * It lives in the Middleware's database rather than the Platform's, for the
 * reason everything per-Customer does: the Platform is the prompt-injection
 * surface, and a store of every Customer's words inside it is precisely what
 * ADR-0006 exists to prevent. The Platform holds a conversation id in memory and
 * nothing else.
 */

export type MessageDirection = "inbound" | "outbound";
export type MessageKind = "said" | "chose" | "event";
export type MessageAuthor = "customer" | "agent" | "officer" | "system";

/** What the platform learned about a file, which is that it exists. */
export interface MessageAttachment {
  /** The object-storage key. Never served to the Platform; see the controller. */
  readonly key: string;
  readonly mediaType: string;
  /** The Customer's own filename, rendered to an Officer and never used as a key. */
  readonly name: string;
}

export interface RecordedMessage {
  readonly conversationId: string;
  readonly direction: MessageDirection;
  readonly kind: MessageKind;
  readonly body: string;
  readonly author: MessageAuthor;
  /** An Officer's id. Only an Officer may be named; the constraint enforces it. */
  readonly authorStaffId?: string;
  readonly attachment?: MessageAttachment;
  /** Written already held, for a reply the WhatsApp window will not carry. */
  readonly held?: boolean;
  /** Agent replies only: whether the Agent made sense of the turn it answers. */
  readonly agentUnderstood?: boolean;
}

/** One line of history, as the Inbox renders it. */
export interface ConversationMessage {
  readonly id: string;
  readonly direction: MessageDirection;
  readonly kind: MessageKind;
  readonly body: string;
  readonly author: MessageAuthor;
  readonly authorStaffId: string | null;
  readonly attachment: (MessageAttachment & { readonly messageId: string }) | null;
  readonly held: boolean;
  readonly agentUnderstood: boolean | null;
  readonly recordedAt: Date;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  direction: MessageDirection;
  kind: MessageKind;
  body: string;
  author: MessageAuthor;
  author_staff_id: string | null;
  attachment_key: string | null;
  attachment_type: string | null;
  attachment_name: string | null;
  held: boolean;
  agent_understood: boolean | null;
  recorded_at: Date;
}

const COLUMNS =
  "id::text, conversation_id::text, direction, kind, body, author, author_staff_id::text, " +
  "attachment_key, attachment_type, attachment_name, held, agent_understood, recorded_at";

const toMessage = (row: MessageRow): ConversationMessage => ({
  id: row.id,
  direction: row.direction,
  kind: row.kind,
  body: row.body,
  author: row.author,
  authorStaffId: row.author_staff_id,
  attachment:
    row.attachment_key && row.attachment_type
      ? {
          messageId: row.id,
          key: row.attachment_key,
          mediaType: row.attachment_type,
          name: row.attachment_name ?? "",
        }
      : null,
  held: row.held,
  agentUnderstood: row.agent_understood,
  recordedAt: row.recorded_at,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class MessagesRepository {
  public constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  public async record(message: RecordedMessage): Promise<ConversationMessage> {
    const { rows } = await this.pool.query<MessageRow>(
      `insert into conversation_messages
         (conversation_id, direction, kind, body, author, author_staff_id,
          attachment_key, attachment_type, attachment_name, held, agent_understood)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       returning ${COLUMNS}`,
      [
        message.conversationId,
        message.direction,
        message.kind,
        message.body,
        message.author,
        message.authorStaffId ?? null,
        message.attachment?.key ?? null,
        message.attachment?.mediaType ?? null,
        message.attachment?.name ?? null,
        message.held ?? false,
        message.agentUnderstood ?? null,
      ],
    );

    return toMessage(rows[0] as MessageRow);
  }

  /** The whole conversation, oldest first. The Inbox's only read. */
  public async history(conversationId: string): Promise<readonly ConversationMessage[]> {
    if (!UUID.test(conversationId)) return [];

    const { rows } = await this.pool.query<MessageRow>(
      `select ${COLUMNS} from conversation_messages where conversation_id = $1 order by id`,
      [conversationId],
    );
    return rows.map(toMessage);
  }

  /**
   * The part of **this** conversation the Support Agent may be shown, oldest
   * first.
   *
   * Four exclusions, and none of them is tidying:
   *
   * - **A `chose` never goes back to a model.** It is an identifier the platform
   *   minted and routed by code; feeding one to a model is the `said`/`chose`
   *   split undone on the way back out. An `event` is not a message at all.
   * - **An Officer's words are not shown.** While a human owns a conversation
   *   the Platform makes no model call at all ([ADR-0012](../../../../docs/adr/0012-a-handoff-transfers-ownership-and-the-model-stops-reading.md)),
   *   and replaying what they wrote afterwards is that window reopened late. The
   *   Agent takes the Customer's *next* message and starts from it. `system`
   *   goes for the same reason — the arrival and resolve notices name a member
   *   of the Bank's staff.
   * - **A message that carried a file is not shown, caption included.** A
   *   document handed to the layer running the LLM is an injection vector with a
   *   file extension, and a sentence beside one is the most natural place in the
   *   product to hide an instruction. It raised a Handoff at the time; it is not
   *   read back now.
   *
   * What remains is what the Customer typed and what the Agent answered, which
   * is exactly *the current conversation* — context the model already had within
   * a turn, and never Library material. Past conversations are out of scope
   * entirely: replaying stored `said` text months later re-opens the injection
   * surface long after anyone would think to look at it.
   */
  public async agentContext(
    conversationId: string,
    limit: number,
  ): Promise<readonly ConversationMessage[]> {
    if (!UUID.test(conversationId)) return [];

    const { rows } = await this.pool.query<MessageRow>(
      `select ${COLUMNS} from conversation_messages
       where conversation_id = $1
         and kind = 'said'
         and author in ('customer', 'agent')
         and attachment_key is null
       order by id desc
       limit $2`,
      [conversationId, limit],
    );
    // Newest first out of the database so the limit takes the *recent* turns,
    // and reversed here rather than re-sorted in SQL: `id` leaves the query as
    // text — a `bigserial` the Platform must never do arithmetic on — and
    // ordering text puts "10" before "9".
    return rows.map(toMessage).reverse();
  }

  /**
   * How many Agent replies in a row failed to understand the Customer.
   *
   * **Handoff trigger 6**, and it observes what happened rather than inferring
   * how somebody feels. A Customer rephrasing the same request and getting *"I
   * did not understand that"* each time is the case a sentiment threshold was
   * supposed to catch, and this catches it from the record instead of from a
   * second model judgement stacked on the first.
   *
   * Counted over Agent replies only, so a Customer's own messages and the
   * platform's notices do not break or extend a run.
   */
  public async consecutiveMisunderstandings(conversationId: string): Promise<number> {
    if (!UUID.test(conversationId)) return 0;

    const { rows } = await this.pool.query<{ agent_understood: boolean | null }>(
      `select agent_understood from conversation_messages
       where conversation_id = $1 and author = 'agent' and agent_understood is not null
       order by id desc`,
      [conversationId],
    );

    let run = 0;
    for (const row of rows) {
      if (row.agent_understood !== false) break;
      run += 1;
    }
    return run;
  }

  /** One message, for serving the file hanging off it. */
  public async findById(messageId: string): Promise<
    (ConversationMessage & { readonly conversationId: string }) | undefined
  > {
    if (!/^\d+$/.test(messageId)) return undefined;

    const { rows } = await this.pool.query<MessageRow>(
      `select ${COLUMNS} from conversation_messages where id = $1`,
      [messageId],
    );
    const row = rows[0];
    return row ? { ...toMessage(row), conversationId: row.conversation_id } : undefined;
  }

  /**
   * Outbound messages the Customer has not been handed yet, for a Channel that
   * has to come and fetch them.
   *
   * In-app chat's whole delivery model: an Officer answers at 9am and the reply
   * is simply waiting when the Customer next opens the Bank's application. There
   * is no window here and nothing is ever held.
   */
  public async outboundSince(
    conversationId: string,
    afterId: string,
  ): Promise<readonly ConversationMessage[]> {
    if (!UUID.test(conversationId)) return [];
    const after = /^\d+$/.test(afterId) ? afterId : "0";

    const { rows } = await this.pool.query<MessageRow>(
      `select ${COLUMNS} from conversation_messages
       where conversation_id = $1 and direction = 'outbound' and not held and id > $2
       order by id`,
      [conversationId, after],
    );
    return rows.map(toMessage);
  }

  /**
   * Whether anything is already waiting on this conversation.
   *
   * **What stops a second approved template going out.** The template is a
   * business-initiated message and draws on the Bank's messaging tier, so a
   * window that has already been knocked on is not knocked on again — the next
   * Officer message simply joins the queue behind the first.
   */
  public async holdsAnything(conversationId: string): Promise<boolean> {
    if (!UUID.test(conversationId)) return false;

    const { rows } = await this.pool.query<{ held: boolean }>(
      "select true as held from conversation_messages where conversation_id = $1 and held limit 1",
      [conversationId],
    );
    return rows.length > 0;
  }

  /**
   * Everything written while WhatsApp's window was shut, released in order.
   *
   * Called the moment a Customer replies to the approved template, which is what
   * reopens the window. Marking them delivered in the same statement that reads
   * them is what stops two concurrent inbound messages sending the held content
   * twice.
   */
  public async releaseHeld(conversationId: string): Promise<readonly ConversationMessage[]> {
    if (!UUID.test(conversationId)) return [];

    const { rows } = await this.pool.query<MessageRow>(
      `update conversation_messages set held = false
       where id in (
         select id from conversation_messages
         where conversation_id = $1 and held
         order by id
         for update skip locked
       )
       returning ${COLUMNS}`,
      [conversationId],
    );
    return rows.map(toMessage).sort((a, b) => Number(a.id) - Number(b.id));
  }
}

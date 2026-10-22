import { randomBytes } from "node:crypto";

import { Inject, Injectable, Logger } from "@nestjs/common";

import type { MiddlewareConfig } from "@avni/config";
import type { Pool } from "@avni/db";
import type { OpenedConversation } from "@avni/intent";
import { CLOCK, DATABASE_POOL, type Clock } from "@avni/service";

import { AuditRepository } from "../audit/audit.repository";
import { MIDDLEWARE_CONFIG } from "../tokens";
import { BindingsRepository, isDormant, type Binding } from "./bindings.repository";
import { SnippetSecretsRepository } from "./snippet-secrets.repository";
import { verifyIdentityEnvelope } from "./signed-identity";

export type Channel = "whatsapp" | "in_app_chat";

export interface Conversation {
  readonly id: string;
  readonly channel: Channel;
  readonly channelIdentity: string;
  readonly bindingId: string | null;
  /** The account an in-app conversation was opened against. Null on WhatsApp. */
  readonly accountNumber: string | null;
}

interface ConversationRow {
  id: string;
  channel: Channel;
  channel_identity: string;
  binding_id: string | null;
  account_number: string | null;
}

/**
 * What opening an in-app conversation answers.
 *
 * A refusal carries **no reason**. The Platform is the prompt-injection surface
 * and has nothing to do with one; the Customer is shown one plain message
 * whatever happened. Why it was refused goes to the log and the audit table,
 * which is where the Bank's mobile engineer can tell a wrong secret from a
 * clock skew.
 */
export type OpenedInAppConversation =
  | ({ readonly outcome: "opened" } & OpenedConversation)
  | { readonly outcome: "refused" };

/**
 * **The Middleware issues the conversation id.**
 *
 * The Platform opens a conversation against a channel identity and receives an
 * unguessable id that it quotes on every later call. It never mints one — a
 * Customer who talked the Support Agent into quoting a different id would
 * otherwise inherit somebody else's security context, and every "the Platform
 * is untrusted" rule downstream would be decorative.
 *
 * What comes back is the id and one bit: whether this conversation reaches an
 * account. Never the account number.
 */
@Injectable()
export class ConversationsService {
  private readonly logger = new Logger(ConversationsService.name);

  public constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    @Inject(BindingsRepository) private readonly bindings: BindingsRepository,
    @Inject(AuditRepository) private readonly audit: AuditRepository,
    @Inject(MIDDLEWARE_CONFIG) private readonly config: MiddlewareConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(SnippetSecretsRepository) private readonly secrets: SnippetSecretsRepository,
  ) {}

  /**
   * Opens a conversation, and answers whether it reaches an account.
   *
   * **A dormant Binding does not.** Ninety days without Customer-initiated
   * contact is exactly the window a Nigerian operator recycles a number in, so
   * the record survives — renewal is what it is for — but nothing banks on it
   * until a code has reached the contact on record.
   */
  public async open(channel: Channel, channelIdentity: string): Promise<OpenedConversation> {
    const found = await this.bindings.findLiveByChannelIdentity(channelIdentity);
    const dormant =
      found !== undefined &&
      isDormant(found, this.clock.now(), this.config.enrollment.bindingDormancyDays);
    const binding = dormant ? undefined : found;

    const conversationId = await this.insert(channel, channelIdentity, {
      bindingId: binding?.id ?? null,
    });

    await this.audit.record({
      action: "conversation.opened",
      actor: { kind: "platform" },
      outcome: "succeeded",
      conversationId,
      ...(binding ? { accountNumber: binding.accountNumber } : {}),
      detail: { channel, identified: binding !== undefined, ...(dormant ? { dormant: true } : {}) },
    });

    return { conversationId, identified: binding !== undefined };
  }

  /**
   * Opens an in-app chat conversation from a signed identity envelope, and
   * **creates no Binding**.
   *
   * The Bank's application has already authenticated the Customer and its
   * backend has signed who they are, so there is nothing to enroll, no code to
   * send, and nothing to remember once the conversation ends
   * ([ADR-0010](../../../../docs/adr/0010-the-in-app-chat-snippet-carries-a-signed-identity.md)).
   * The account is stamped on the conversation instead — which is also why a
   * Customer opening the Bank's app does not disturb the WhatsApp Binding they
   * hold, where one-live-Binding-per-account would have revoked it on every
   * launch.
   *
   * **This is where the envelope is verified**, and nowhere else. The Platform
   * forwards an opaque string; the secret it was signed with never leaves this
   * deployable ([ADR-0006](../../../../docs/adr/0006-secrets-and-security-records-live-outside-the-platform.md)).
   */
  public async openInApp(envelope: string): Promise<OpenedInAppConversation> {
    const verified = verifyIdentityEnvelope(
      envelope,
      await this.secrets.secretsForVerification(),
      this.clock.now(),
    );

    if (verified.outcome === "refused") {
      // Recorded with the reason and without the envelope. This row is the only
      // place a wrong secret can be told from a clock skew, and an envelope in
      // the audit table would be a bearer credential sitting in the one table
      // the Bank looks at during an investigation.
      this.logger.warn({ event: "in_app_identity_refused", reason: verified.reason });
      await this.audit.record({
        action: "conversation.opened",
        actor: { kind: "platform" },
        outcome: "refused",
        detail: { channel: "in_app_chat", reason: verified.reason },
      });
      return { outcome: "refused" };
    }

    const conversationId = await this.insert("in_app_chat", inAppHandle(), {
      accountNumber: verified.accountNumber,
    });

    await this.audit.record({
      action: "conversation.opened",
      actor: { kind: "platform" },
      outcome: "succeeded",
      conversationId,
      accountNumber: verified.accountNumber,
      detail: { channel: "in_app_chat", identified: true, binding: false },
    });

    // Always identified: an unverifiable envelope never gets this far, so there
    // is no in-app conversation that reaches nothing.
    return { outcome: "opened", conversationId, identified: true };
  }

  private async insert(
    channel: Channel,
    channelIdentity: string,
    row: { readonly bindingId?: string | null; readonly accountNumber?: string | null },
  ): Promise<string> {
    const { rows } = await this.pool.query<ConversationRow>(
      `insert into conversations (channel, channel_identity, binding_id, account_number)
       values ($1, $2, $3, $4)
       returning ${CONVERSATION_COLUMNS}`,
      [channel, channelIdentity, row.bindingId ?? null, row.accountNumber ?? null],
    );
    return (rows[0] as ConversationRow).id;
  }

  public async findById(conversationId: string): Promise<Conversation | undefined> {
    // An id the Platform made up is a `not found`, not a crash, so a malformed
    // one must not reach Postgres as a uuid cast error.
    if (!UUID.test(conversationId)) return undefined;

    const { rows } = await this.pool.query<ConversationRow>(
      `select ${CONVERSATION_COLUMNS} from conversations where id = $1`,
      [conversationId],
    );
    const row = rows[0];
    return row
      ? {
          id: row.id,
          channel: row.channel,
          channelIdentity: row.channel_identity,
          bindingId: row.binding_id,
          accountNumber: row.account_number,
        }
      : undefined;
  }

  /**
   * The account this conversation reaches, or nothing.
   *
   * **The two Channels answer this differently, and that difference is the only
   * one there is.** WhatsApp arrives carrying a number that means nothing to us,
   * so the account is re-read from the Binding every time — a Binding revoked
   * mid-conversation stops working immediately, because a Customer reporting a
   * stolen phone should not have to wait for the conversation to end, and
   * dormancy is re-checked for the same reason. In-app chat was told who the
   * Customer was, by a backend that signed it, and there is no Binding to
   * revoke and no dormancy to expire.
   */
  public async accountFor(conversationId: string): Promise<string | undefined> {
    const conversation = await this.findById(conversationId);
    if (!conversation) return undefined;

    if (conversation.channel === "in_app_chat") return conversation.accountNumber ?? undefined;

    const binding = await this.bindingFor(conversationId);
    return binding?.accountNumber;
  }

  /**
   * The live, non-dormant Binding behind a conversation, or nothing.
   *
   * Resolved from the **channel identity** rather than from the `binding_id`
   * stamped when the conversation opened, and both directions of that matter. A
   * Binding revoked mid-conversation stops working immediately, because a
   * Customer reporting a stolen phone should not have to wait for the
   * conversation to end. And a Customer who enrols *during* a conversation —
   * which is the ordinary way this happens, since they were talking to us before
   * they linked — is identified from their very next message rather than from
   * their next conversation.
   */
  public async bindingFor(conversationId: string): Promise<Binding | undefined> {
    const conversation = await this.findById(conversationId);
    if (!conversation) return undefined;
    // **In-app chat has no Binding at all**, and refusing here rather than
    // relying on the handle matching nothing is what keeps that a rule instead
    // of a coincidence. Everything downstream of this — unlinking, renewal,
    // dormancy — is WhatsApp's, and none of it should half-work on a Channel
    // that has nothing for it to act on.
    if (conversation.channel === "in_app_chat") return undefined;

    const binding: Binding | undefined = await this.bindings.findLiveByChannelIdentity(
      conversation.channelIdentity,
    );
    if (!binding) return undefined;

    return isDormant(binding, this.clock.now(), this.config.enrollment.bindingDormancyDays)
      ? undefined
      : binding;
  }

  /**
   * Marks Customer-initiated activity, on the conversation **and on the
   * Binding**. Never called for a message *we* send: a notification to an
   * already-recycled number must not keep alive exactly the Binding that
   * dormancy expiry exists to kill.
   */
  public async touch(conversationId: string): Promise<void> {
    if (!UUID.test(conversationId)) return;
    // The platform's clock rather than Postgres's. WhatsApp's 24-hour window is
    // measured against this column, and a window whose two ends are read from
    // two different clocks is one no test can move and no operator can reason
    // about.
    await this.pool.query("update conversations set last_seen_at = $2 where id = $1", [
      conversationId,
      this.clock.now(),
    ]);
    await this.bindings.noteActivityForConversation(conversationId, this.dormantOnOrBefore());
  }

  /**
   * When this conversation last heard from the **Customer**.
   *
   * The one input to WhatsApp's 24-hour window, and the reason `touch` is only
   * ever called for Customer-initiated contact: a reply *we* sent refreshing
   * this would reopen the window on the strength of our own message, which is
   * exactly what the window forbids.
   */
  public async lastHeardFrom(conversationId: string): Promise<Date | undefined> {
    if (!UUID.test(conversationId)) return undefined;

    const { rows } = await this.pool.query<{ last_seen_at: Date }>(
      "select last_seen_at from conversations where id = $1",
      [conversationId],
    );
    return rows[0]?.last_seen_at;
  }

  /** The instant a Binding must have been used after, to still be live. */
  private dormantOnOrBefore(): Date {
    return new Date(
      this.clock.now().getTime() - this.config.enrollment.bindingDormancyDays * DAY_MS,
    );
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DAY_MS = 24 * 60 * 60 * 1000;

const CONVERSATION_COLUMNS = "id, channel, channel_identity, binding_id, account_number";

/**
 * What names the correspondent on in-app chat.
 *
 * Random and per-conversation, because nothing else would do. The account
 * number is the one thing that must never be a channel identity — it would put
 * a Customer's account into the same column a WhatsApp number lives in, and
 * `noteActivityForConversation` matches on that column, so opening the Bank's
 * app would start refreshing the dormancy clock on a Binding it has nothing to
 * do with. A handle that matches nothing is the point.
 */
const inAppHandle = (): string => `in-app:${randomBytes(16).toString("base64url")}`;

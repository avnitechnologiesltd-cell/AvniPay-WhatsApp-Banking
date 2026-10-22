import { Inject, Injectable, Logger } from "@nestjs/common";

import type { MiddlewareConfig } from "@avni/config";
import { CLOCK, type Clock } from "@avni/service";

import type { Actor } from "../audit/actions";
import { AuditRepository } from "../audit/audit.repository";
import { BankIdentityClient } from "../enrollment/bank-identity.client";
import { ConversationsService, type Conversation } from "../identity/conversations.service";
import { sendWhatsAppReopenTemplate, sendWhatsAppText } from "../notifications/whatsapp";
import { hoursInWords, isOpenAt } from "../settings/business-hours";
import { SettingsRepository } from "../settings/settings.repository";
import { StaffRepository, type StaffAccount } from "../staff/staff.repository";
import { BANK_IDENTITY_CLIENT, MIDDLEWARE_CONFIG } from "../tokens";
import {
  HANDOFF_WORDS,
  pagesOperations,
  waitsForBusinessHours,
  windowIsOpen,
  type HandoffTrigger,
} from "./handoff";
import { HandoffsRepository, type Handoff } from "./handoffs.repository";
import {
  MessagesRepository,
  type ConversationMessage,
  type MessageAttachment,
} from "./messages.repository";

/**
 * The path from the AI to a human, and back.
 *
 * **The Agent leaves completely.** Not silent-but-listening, and not suggesting
 * replies to the Officer. Silent-but-listening costs the same as leaving and
 * buys nothing, because the history is stored either way; suggestion mode is a
 * genuine capability increase resting on a ~68% figure, aimed at a human who
 * will be inclined to trust it. The security case settles it: while an Officer
 * owns the conversation the Platform stops feeding those messages to a model at
 * all, so **the injection surface closes at exactly the moment a human is being
 * asked to trust what they are reading**.
 *
 * That is why {@link HandoffService.ownerOf} exists and why the Platform asks it
 * on every single turn rather than remembering the answer.
 */

/** Who is answering this conversation right now. There is no third answer. */
export type ConversationOwner = "agent" | "officer";

/**
 * What raising a Handoff answers, so the Platform can say something true.
 *
 * **The hours come back as a rendered fragment, not as the setting.** The
 * Middleware holds the configuration and the Platform renders the sentence
 * around it — the same division that made `SurfaceNotApplicable` a code rather
 * than a sentence, applied to the one value the Platform genuinely cannot
 * compose without.
 */
export type HandoffRaised =
  | { readonly outcome: "raised"; readonly waiting: "now" }
  | { readonly outcome: "raised"; readonly waiting: "out_of_hours"; readonly hours: string }
  /** An Officer already owns this conversation. Saying so twice helps nobody. */
  | { readonly outcome: "already_open" }
  | { readonly outcome: "no_such_conversation" };

/** One row of the Inbox, as an Officer scanning it sees it. */
export interface InboxEntry {
  readonly handoffId: string;
  readonly conversationId: string;
  readonly trigger: HandoffTrigger;
  readonly summary: string;
  readonly raisedAt: Date;
  readonly channel: Conversation["channel"];
  /** Resolved per Channel: through the Binding, or stamped on the conversation. */
  readonly accountNumber: string | null;
  /** Null when unclaimed **or** when the claim has gone stale and expired. */
  readonly claimedBy: { readonly id: string; readonly displayName: string } | null;
}

/**
 * One line of history as the Dashboard sees it — **without the object key**.
 *
 * An Officer names a *message* to fetch a file, never a key. Keeping the key
 * out of the payload means a compromised Dashboard session holds no addresses
 * in object storage, and the scoping check on the way back out is the only path
 * to a file there is.
 */
export type HistoryLine = Omit<ConversationMessage, "attachment"> & {
  readonly attachment:
    | { readonly messageId: string; readonly mediaType: string; readonly name: string }
    | null;
};

/** Everything an Officer needs to answer without re-asking the Customer. */
export interface ConversationForOfficer extends InboxEntry {
  readonly history: readonly HistoryLine[];
  readonly resolvedAt: Date | null;
}

export type ClaimOutcome =
  | { readonly outcome: "claimed"; readonly entry: InboxEntry }
  /** Somebody else holds it and is still working it. */
  | { readonly outcome: "taken"; readonly by: string }
  | { readonly outcome: "not_found" };

export type OfficerActOutcome<T> =
  | ({ readonly outcome: "done" } & T)
  /** The Officer does not hold a live claim — never claimed, or it expired. */
  | { readonly outcome: "not_yours" }
  | { readonly outcome: "not_found" };

@Injectable()
export class HandoffService {
  private readonly logger = new Logger(HandoffService.name);

  public constructor(
    @Inject(MIDDLEWARE_CONFIG) private readonly config: MiddlewareConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(HandoffsRepository) private readonly handoffs: HandoffsRepository,
    @Inject(MessagesRepository) private readonly messages: MessagesRepository,
    @Inject(ConversationsService) private readonly conversations: ConversationsService,
    @Inject(SettingsRepository) private readonly settings: SettingsRepository,
    @Inject(StaffRepository) private readonly staff: StaffRepository,
    @Inject(AuditRepository) private readonly audit: AuditRepository,
    @Inject(BANK_IDENTITY_CLIENT) private readonly identity: BankIdentityClient,
  ) {}

  // --- Ownership ------------------------------------------------------------

  /**
   * Who owns this conversation, asked fresh every turn.
   *
   * **Ownership passes when the Handoff is raised, not when it is claimed.** A
   * Customer waiting in the queue for an Officer must not get bot replies in the
   * meantime — the Agent has left, and a queue is not a mode the Agent hangs
   * around in.
   */
  public async ownerOf(conversationId: string): Promise<ConversationOwner> {
    return (await this.handoffs.openFor(conversationId)) ? "officer" : "agent";
  }

  /**
   * The conversation an Officer is already holding for this channel identity.
   *
   * **What keeps ownership alive across a Platform restart.** The Platform caches
   * conversation ids in memory and asks again when it has forgotten one; without
   * this it would be handed a fresh conversation, with no Handoff on it, and the
   * Agent would start answering over an Officer who is still typing into the
   * old one. Only ever consulted for a Channel that has a stable identity —
   * in-app chat presents a signed envelope every session and has no such thing.
   */
  public async conversationHeldByAnOfficer(
    channel: Conversation["channel"],
    channelIdentity: string,
  ): Promise<string | undefined> {
    if (channel !== "whatsapp") return undefined;
    const held = await this.handoffs.openForChannelIdentity(channel, channelIdentity);
    return held?.conversationId;
  }

  // --- Raising --------------------------------------------------------------

  /**
   * Raises a Handoff, tells the Customer, and — for the one trigger that needs
   * it — pages the Bank.
   *
   * `summary` is the Agent's own account of what it tried. An Officer who has to
   * re-ask the Customer everything makes the Handoff worse than no Agent, and
   * this plus the `said`/`chose`/`event` history is what stops that.
   */
  public async raise(
    conversationId: string,
    trigger: HandoffTrigger,
    summary: string,
    detail: Readonly<Record<string, unknown>> = {},
  ): Promise<HandoffRaised> {
    const conversation = await this.conversations.findById(conversationId);
    if (!conversation) return { outcome: "no_such_conversation" };

    const { handoff, raised } = await this.handoffs.open(conversationId, trigger, summary);
    const accountNumber = await this.conversations.accountFor(conversationId);

    if (!raised) {
      // A second trigger firing while a human already owns the conversation is
      // recorded and does nothing else. Telling the Customer again that we are
      // finding them somebody is noise, and a second Inbox row for one
      // conversation is the thing the unique index exists to refuse.
      await this.audit.record({
        action: "handoff.triggered",
        actor: { kind: "system" },
        outcome: "refused",
        conversationId,
        ...(accountNumber ? { accountNumber } : {}),
        detail: { ...detail, trigger, reason: "a Handoff is already open", handoffId: handoff.id },
      });
      return { outcome: "already_open" };
    }

    await this.audit.record({
      action: "handoff.triggered",
      actor: { kind: "system" },
      outcome: "succeeded",
      conversationId,
      ...(accountNumber ? { accountNumber } : {}),
      detail: { ...detail, trigger, handoffId: handoff.id, channel: conversation.channel },
    });

    // Somebody is woken up. Asked as its own question rather than as the
    // inverse of the hours one below, because they are different facts.
    if (pagesOperations(trigger)) {
      await this.alertOperations(handoff, conversation, accountNumber, detail);
    }

    // And the hours are not consulted for a transfer nobody can account for: it
    // is not something to tell a Customer we will look at on Monday.
    if (!waitsForBusinessHours(trigger)) return { outcome: "raised", waiting: "now" };

    const { businessHours } = await this.settings.all();
    // Unset hours mean the platform does not know when somebody will answer, so
    // it does not claim to. It never invents a timetable on the Bank's behalf.
    if (!businessHours || isOpenAt(businessHours, this.clock.now())) {
      return { outcome: "raised", waiting: "now" };
    }

    return { outcome: "raised", waiting: "out_of_hours", hours: hoursInWords(businessHours) };
  }

  /**
   * Handoff trigger 3: a Gated Connector the Customer failed the PIN on.
   *
   * A named method rather than a `trigger` string a caller passes, because the
   * caller is the Connector dispatch path in the Middleware
   * (ticket 40)
   * and **the Platform must never be able to claim it**. The Platform does not
   * see a Transaction PIN, so it cannot know one was wrong; a route that let it
   * say so would let a Customer's text manufacture the claim.
   */
  public gatedPinFailed(
    conversationId: string,
    connector: string,
    summary: string,
  ): Promise<HandoffRaised> {
    return this.raise(conversationId, "gated_pin_failed", summary, { connector });
  }

  /**
   * Pages the Bank's operations desk about a transfer nobody can account for.
   *
   * **To the Bank, not the Customer** — so it needs no approved template and
   * draws on no messaging tier. An address the Bank has not set is not a quiet
   * no-op: it is an error in the log and an `unavailable` row in the one table
   * they look at, because the whole point of this trigger is that it is never
   * sitting silently in a queue at 3am.
   */
  private async alertOperations(
    handoff: Handoff,
    conversation: Conversation,
    accountNumber: string | undefined,
    detail: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const { operationsAlertAddress } = await this.settings.all();

    if (!operationsAlertAddress) {
      this.logger.error({
        event: "operations_alert_address_unset",
        handoffId: handoff.id,
        conversationId: conversation.id,
      });
      await this.audit.record({
        action: "handoff.operations_alerted",
        actor: { kind: "system" },
        outcome: "unavailable",
        conversationId: conversation.id,
        ...(accountNumber ? { accountNumber } : {}),
        detail: { handoffId: handoff.id, reason: "no operations alert address is configured" },
      });
      return;
    }

    const sent = await this.identity.alertOperations(
      operationsAlertAddress,
      "A transfer is unresolved and needs a Support Officer",
      // The account number and the reference, and nothing a Customer wrote. This
      // leaves the platform and lands in a mailbox we do not control.
      [
        `Account: ${accountNumber ?? "unknown"}`,
        `Conversation: ${conversation.id}`,
        `Handoff: ${handoff.id}`,
        `Detail: ${JSON.stringify(detail)}`,
      ].join("\n"),
      handoff.id,
    );

    await this.audit.record({
      action: "handoff.operations_alerted",
      actor: { kind: "system" },
      outcome: sent.outcome === "sent" ? "succeeded" : "unavailable",
      conversationId: conversation.id,
      ...(accountNumber ? { accountNumber } : {}),
      detail: {
        handoffId: handoff.id,
        ...(sent.reason === undefined ? {} : { reason: sent.reason }),
      },
    });
  }

  // --- The history ----------------------------------------------------------

  /**
   * Records what a Customer said, chose or did, and answers who owns the
   * conversation now.
   *
   * One call rather than two, because the Platform must not be able to answer a
   * message it has not yet been told the owner of. Bundling the two makes
   * "record, then check, then answer" a single round trip that cannot be
   * performed in the wrong order.
   */
  public async receiveFromCustomer(message: {
    readonly conversationId: string;
    readonly kind: ConversationMessage["kind"];
    readonly body: string;
    readonly attachment?: MessageAttachment;
  }): Promise<{ readonly owner: ConversationOwner }> {
    await this.messages.record({
      conversationId: message.conversationId,
      direction: "inbound",
      kind: message.kind,
      body: message.body,
      author: "customer",
      ...(message.attachment ? { attachment: message.attachment } : {}),
    });

    // **An `event` is inbound and is not contact.** A delivery receipt says a
    // message *we* sent arrived; a Flow reply is the receipt for work that
    // already happened at the Middleware. Letting either move the clocks below
    // would refresh a Binding's dormancy on the strength of our own message and
    // reopen WhatsApp's window on the strength of our own message — which is
    // precisely what both rules exist to prevent.
    if (message.kind !== "event") {
      // Customer-initiated contact: the conversation's clock and the Binding's
      // dormancy clock both move, and WhatsApp's window reopens.
      await this.conversations.touch(message.conversationId);
      await this.releaseHeld(message.conversationId);
    }

    return { owner: await this.ownerOf(message.conversationId) };
  }

  /**
   * Records what the Agent answered, and raises **trigger 6** when the Agent has
   * failed to understand three turns running.
   *
   * The count is the Middleware's rather than the Platform's, and durably so: a
   * tally in the Platform's memory would reset on a restart or land on a second
   * replica, and the Customer would rephrase forever.
   */
  public async recordAgentReply(
    conversationId: string,
    body: string,
    understood: boolean,
  ): Promise<HandoffRaised | undefined> {
    await this.messages.record({
      conversationId,
      direction: "outbound",
      kind: "said",
      body,
      author: "agent",
      agentUnderstood: understood,
    });

    if (understood) return undefined;

    const run = await this.messages.consecutiveMisunderstandings(conversationId);
    if (run < MISUNDERSTANDINGS_BEFORE_HANDOFF) return undefined;

    return this.raise(
      conversationId,
      "repeated_failure",
      `The Customer asked ${run} times and the Agent did not understand any of them.`,
      { misunderstandings: run },
    );
  }

  /**
   * Everything an Officer wrote while WhatsApp's window was shut, sent now that
   * the Customer has replied.
   *
   * The template reopened the conversation and this is the real content it was
   * standing in for. In-app chat never reaches here with anything, because
   * nothing is ever held on a Channel with no window.
   */
  private async releaseHeld(conversationId: string): Promise<void> {
    const conversation = await this.conversations.findById(conversationId);
    if (!conversation || conversation.channel !== "whatsapp") return;

    for (const message of await this.messages.releaseHeld(conversationId)) {
      await sendWhatsAppText(this.config.whatsapp, conversation.channelIdentity, message.body);
    }
  }

  // --- The Inbox ------------------------------------------------------------

  /** One shared Inbox, urgent first. Every Officer sees the same list. */
  public async inbox(): Promise<readonly InboxEntry[]> {
    const open = await this.handoffs.openHandoffs();
    return Promise.all(open.map((handoff) => this.entryFor(handoff)));
  }

  /** One conversation, with the history and the summary the Officer needs. */
  public async view(handoffId: string): Promise<ConversationForOfficer | undefined> {
    const handoff = await this.handoffs.findById(handoffId);
    if (!handoff) return undefined;

    const history = await this.messages.history(handoff.conversationId);

    return {
      ...(await this.entryFor(handoff)),
      history: history.map(({ attachment, ...line }) => ({
        ...line,
        attachment: attachment
          ? {
              messageId: attachment.messageId,
              mediaType: attachment.mediaType,
              name: attachment.name,
            }
          : null,
      })),
      resolvedAt: handoff.resolvedAt,
    };
  }

  public async claim(handoffId: string, officer: StaffAccount): Promise<ClaimOutcome> {
    const existing = await this.handoffs.findById(handoffId);
    if (!existing || existing.resolvedAt) return { outcome: "not_found" };

    const claimed = await this.handoffs.claim(
      handoffId,
      officer.id,
      this.clock.now(),
      this.idleBefore(),
    );

    if (!claimed) {
      const holder = existing.claimedBy ? await this.staff.findById(existing.claimedBy) : undefined;
      return { outcome: "taken", by: holder?.displayName ?? "another officer" };
    }

    // **The Customer is told, by name, whenever the name changes.** Never
    // silent: swapping an AI for a human without saying so is a disclosure
    // problem for a licensed institution, and so is swapping one human for
    // another — a Customer who was introduced to Amaka and is then answered by
    // Bola, and later told *"Bola has closed this chat"*, has been handed a name
    // they never heard.
    //
    // The one case that stays quiet is the same Officer reclaiming after their
    // own claim lapsed. Reintroducing somebody the Customer is already talking
    // to would be the platform narrating its own plumbing.
    const newFace = existing.claimedBy !== officer.id;
    if (newFace) {
      await this.tell(
        claimed,
        HANDOFF_WORDS.officerArrived(officer.displayName, this.config.bankName),
        { author: "system" },
      );
    }

    await this.audit.record({
      action: "handoff.claimed",
      actor: actorFor(officer),
      outcome: "succeeded",
      conversationId: claimed.conversationId,
      detail: {
        handoffId,
        trigger: claimed.trigger,
        // Three states worth telling apart afterwards: the first Officer, the
        // same one picking their own lapsed claim back up, and a second Officer
        // taking over one that went stale.
        takenOver: newFace && existing.claimedBy !== null,
        reclaimed: !newFace,
      },
    });

    return { outcome: "claimed", entry: await this.entryFor(claimed) };
  }

  /**
   * An Officer's own words, on whichever Channel the Customer is on.
   *
   * **Composed and delivered here, never generated by the Platform.** On
   * WhatsApp the Middleware pushes it over the Graph API itself, exactly as it
   * does a transfer's outcome. On in-app chat the Widget fetches it *through*
   * the Platform, because that is where all ordinary conversation on that
   * Channel goes — and an Officer's support message is transcript rather than a
   * secret, so the courier is correct there
   * ([ADR-0012](../../../../docs/adr/0012-a-handoff-transfers-ownership-and-the-model-stops-reading.md)).
   */
  public async reply(
    handoffId: string,
    officer: StaffAccount,
    body: string,
  ): Promise<OfficerActOutcome<{ readonly delivery: Delivery }>> {
    const held = await this.heldBy(handoffId, officer);
    if (held.outcome !== "done") return held;

    const delivery = await this.tell(held.handoff, body, {
      author: "officer",
      authorStaffId: officer.id,
    });

    await this.audit.record({
      action: "handoff.replied",
      actor: actorFor(officer),
      outcome: "succeeded",
      conversationId: held.handoff.conversationId,
      // The words are in `conversation_messages`, not here. The audit table
      // records that an Officer answered and how it went out, and the Bank reads
      // what was said from the conversation itself.
      detail: { handoffId, delivery },
    });

    return { outcome: "done", delivery };
  }

  /**
   * The Officer resolves, and the Agent takes the Customer's **next** message.
   *
   * There is no mid-conversation handback and no idle auto-return. An explicit
   * handback was rejected as a mechanism nobody needs — it is "close the ticket",
   * which every support team already does — and inventing a second verb for it
   * would create a state where neither party owns the conversation.
   */
  public async resolve(
    handoffId: string,
    officer: StaffAccount,
  ): Promise<OfficerActOutcome<{ readonly delivery: Delivery }>> {
    const held = await this.heldBy(handoffId, officer);
    if (held.outcome !== "done") return held;

    const resolved = await this.handoffs.resolve(
      handoffId,
      officer.id,
      this.clock.now(),
      this.idleBefore(),
    );
    if (!resolved) return { outcome: "not_yours" };

    const delivery = await this.tell(
      resolved,
      HANDOFF_WORDS.officerResolved(officer.displayName),
      { author: "system" },
    );

    await this.audit.record({
      action: "handoff.resolved",
      actor: actorFor(officer),
      outcome: "succeeded",
      conversationId: resolved.conversationId,
      detail: { handoffId, trigger: resolved.trigger, delivery },
    });

    return { outcome: "done", delivery };
  }

  // --- Delivery -------------------------------------------------------------

  /**
   * How an outbound support message actually reached the Customer.
   *
   * `waiting` is in-app chat's whole story: there is no window, so a reply
   * written at 9am is simply there when the Customer next opens the Bank's
   * application. `template` is WhatsApp's late-resolve case, and the real
   * content is held behind it.
   */
  private async tell(
    handoff: Handoff,
    body: string,
    author: { readonly author: "officer" | "system"; readonly authorStaffId?: string },
  ): Promise<Delivery> {
    const conversation = await this.conversations.findById(handoff.conversationId);
    if (!conversation) return "undeliverable";

    const delivery = await this.deliver(conversation, body);

    await this.messages.record({
      conversationId: handoff.conversationId,
      direction: "outbound",
      kind: "said",
      body,
      author: author.author,
      ...(author.authorStaffId ? { authorStaffId: author.authorStaffId } : {}),
      held: delivery === "template",
    });

    return delivery;
  }

  private async deliver(conversation: Conversation, body: string): Promise<Delivery> {
    // **In-app chat has no window and no template approval** (ADR-0010). The
    // Widget fetches what is waiting when the Customer next opens it, so there
    // is nothing to send and nothing to hold.
    if (conversation.channel === "in_app_chat") return "waiting";

    const lastHeard = await this.conversations.lastHeardFrom(conversation.id);
    if (lastHeard && !windowIsOpen(lastHeard, this.clock.now())) {
      // The window shut. Only the approved template may go out, and the real
      // words wait until the Customer replies.
      //
      // **Once per shut window, not once per message.** The template is a
      // business-initiated message that draws on the Bank's messaging tier, and
      // a Customer who is already holding one does not need a second — the
      // Officer's next sentence joins the queue behind the first.
      if (await this.messages.holdsAnything(conversation.id)) return "template";

      const sent = await sendWhatsAppReopenTemplate(
        this.config.whatsapp,
        conversation.channelIdentity,
      );
      return sent ? "template" : "undeliverable";
    }

    const sent = await sendWhatsAppText(this.config.whatsapp, conversation.channelIdentity, body);
    return sent ? "sent" : "undeliverable";
  }

  // --- Shared bits ----------------------------------------------------------

  /**
   * Resolves a Handoff the given Officer still holds, refreshing their claim.
   *
   * Every act an Officer performs goes through here, which is what makes the
   * idle expiry mean something: the claim survives on activity, and reading is
   * not activity.
   */
  private async heldBy(
    handoffId: string,
    officer: StaffAccount,
  ): Promise<
    | { readonly outcome: "done"; readonly handoff: Handoff }
    | { readonly outcome: "not_yours" }
    | { readonly outcome: "not_found" }
  > {
    const existing = await this.handoffs.findById(handoffId);
    if (!existing || existing.resolvedAt) return { outcome: "not_found" };

    const live = await this.handoffs.noteActivity(
      handoffId,
      officer.id,
      this.clock.now(),
      this.idleBefore(),
    );
    return live ? { outcome: "done", handoff: live } : { outcome: "not_yours" };
  }

  private async entryFor(handoff: Handoff): Promise<InboxEntry> {
    const conversation = await this.conversations.findById(handoff.conversationId);
    const accountNumber = await this.conversations.accountFor(handoff.conversationId);
    const holder = this.claimIsLive(handoff)
      ? await this.staff.findById(handoff.claimedBy as string)
      : undefined;

    return {
      handoffId: handoff.id,
      conversationId: handoff.conversationId,
      trigger: handoff.trigger,
      summary: handoff.summary,
      raisedAt: handoff.raisedAt,
      channel: conversation?.channel ?? "whatsapp",
      accountNumber: accountNumber ?? null,
      claimedBy: holder ? { id: holder.id, displayName: holder.displayName } : null,
    };
  }

  /**
   * Whether a claim still holds. **Expiry is a read, not a sweep** — the
   * conversation is back in the queue the moment the window passes, with no job
   * standing between the Customer and the next Officer.
   */
  private claimIsLive(handoff: Handoff): boolean {
    if (!handoff.claimedBy || !handoff.officerLastActiveAt) return false;
    return handoff.officerLastActiveAt >= this.idleBefore();
  }

  private idleBefore(): Date {
    return new Date(
      this.clock.now().getTime() - this.config.handoff.claimIdleMinutes * 60_000,
    );
  }
}

export type Delivery = "sent" | "waiting" | "template" | "undeliverable";

/**
 * Who acted, for the audit table.
 *
 * The two roles **nest**, so an Administrator working the Inbox is recorded as
 * an administrator rather than flattened to an officer — the distinction is the
 * whole reason the audit table has an `actorKind`, and re-deriving it at three
 * call sites is how the three drift.
 */
const actorFor = (officer: StaffAccount): Actor => ({
  kind: officer.role === "administrator" ? "administrator" : "officer",
  id: officer.id,
});

/**
 * Three, and not two.
 *
 * Two is one bad parse away from pulling a Customer out of a conversation they
 * were happy to keep having; four is a Customer typing the same sentence into a
 * wall. The ticket says *"the Customer rephrasing the same request three
 * times"*, and this is that sentence as a number.
 */
const MISUNDERSTANDINGS_BEFORE_HANDOFF = 3;

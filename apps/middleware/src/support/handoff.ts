/**
 * **A Handoff is a transfer of ownership, not a mode.**
 *
 * The Support Agent leaves completely, a named Support Officer arrives, the
 * Customer is told both times, and the conversation returns to the Agent only
 * when the Officer resolves it. Everything in this file is the vocabulary that
 * makes those four clauses checkable.
 *
 * The prior art makes a promise it does not keep: `omari core` has an `escalate`
 * intent that replies *"Connecting you to a support agent now..."*, sets
 * `session["state"] = "escalated"`, and stops. **That value is written and never
 * read anywhere in its codebase** — there is no Inbox, no Officer, no queue, and
 * the next message routes straight back to the bot. Nothing there is portable,
 * which is why none of this is a port.
 */

/**
 * The six, in urgency order. **There is no seventh, and there is no sentiment
 * threshold.**
 *
 * Sentiment was on the ticket and does not survive. It is a second model
 * judgement stacked on one already measured at ~68%, and its failure mode is bad
 * in both directions: a frustrated Customer who wants the bot to just answer
 * gets pulled into a queue against their wishes, and an evenly-worded complaint
 * gets nothing. `repeated_failure` catches the real cases by observing what
 * happened rather than inferring how somebody feels.
 */
export const HANDOFF_TRIGGERS = [
  /**
   * A transfer still `pending` when the inline poll bound expired. Money has
   * left the Customer's account and the platform cannot say where it went, so
   * this is the top of the queue always — and the only trigger that never waits
   * for business hours and raises an alert outside the Inbox.
   */
  "pending_transfer",
  /** The Customer asked for a human. Arguing with them is worse support. */
  "customer_asked",
  /**
   * A Gated Connector the Customer failed the Transaction PIN on. The lockout is
   * an hour (ADR-0009) and they still need whatever they came for.
   */
  "gated_pin_failed",
  /** The Agent judges itself unable to answer. The default case. */
  "agent_unable",
  /** A Channel cannot fulfil what was asked. Ticket 05's rule, generalised. */
  "channel_cannot_fulfil",
  /** The Customer rephrasing the same request and getting nowhere. */
  "repeated_failure",
] as const;

export type HandoffTrigger = (typeof HANDOFF_TRIGGERS)[number];

/**
 * The four the **Platform** may claim, and the two it may not.
 *
 * `pending_transfer` is the Middleware's own: it is raised from the transfer
 * path, it pages the Bank's operations desk, and a Customer who talked the
 * Support Agent into claiming it would be able to wake somebody at 3am with a
 * sentence. `gated_pin_failed` is the Middleware's for the same reason in
 * miniature — the Platform never sees a Transaction PIN and so cannot know one
 * was wrong.
 */
export const PLATFORM_TRIGGERS = [
  "customer_asked",
  "agent_unable",
  "channel_cannot_fulfil",
  "repeated_failure",
] as const satisfies readonly HandoffTrigger[];

export type PlatformTrigger = (typeof PLATFORM_TRIGGERS)[number];

/**
 * How the Inbox is ordered, and it is not by arrival.
 *
 * A stuck transfer raised an hour ago outranks a Customer who asked for a human
 * a minute ago, because one of them is missing money. Within a rank it *is* by
 * arrival, which is the only fair tiebreak.
 */
const URGENCY: Record<HandoffTrigger, number> = {
  pending_transfer: 0,
  customer_asked: 1,
  gated_pin_failed: 2,
  agent_unable: 3,
  channel_cannot_fulfil: 4,
  repeated_failure: 5,
};

export const urgencyOf = (trigger: HandoffTrigger): number => URGENCY[trigger];

/**
 * Whether this trigger waits for business hours.
 *
 * **Trigger 1 does not.** A transfer stuck overnight is not something to tell a
 * Customer we will look at on Monday, so it is the one trigger where the Bank's
 * opening hours are not consulted and the Customer is told nothing about them.
 */
export const waitsForBusinessHours = (trigger: HandoffTrigger): boolean =>
  trigger !== "pending_transfer";

/**
 * Whether this trigger pages the Bank's operations desk, **outside the Inbox**.
 *
 * A separate question from {@link waitsForBusinessHours}, even though today one
 * trigger answers yes to one and no to the other. They are different facts —
 * *when will somebody look at this* and *is somebody woken up* — and one
 * predicate serving both is how the second one silently changes with the first.
 *
 * A transfer stuck overnight means a Customer's money is gone and nobody is
 * looking at it until morning. Whether the Bank staffs that address is the
 * Bank's decision; the platform's obligation is to make sure it is never sitting
 * silently in a queue at 3am.
 */
export const pagesOperations = (trigger: HandoffTrigger): boolean =>
  trigger === "pending_transfer";

/**
 * WhatsApp's customer service window. **A delivery constraint, not a
 * conversation** (ticket 11).
 *
 * Meta's rule and therefore a constant rather than configuration — a
 * deployment that could shorten it would be lying to itself, and one that could
 * lengthen it would fail at the Graph API. In-app chat has no equivalent: an
 * unread reply simply waits in the Bank's application.
 */
export const WHATSAPP_WINDOW_MS = 24 * 60 * 60 * 1000;

export const windowIsOpen = (lastCustomerMessageAt: Date, now: Date): boolean =>
  now.getTime() - lastCustomerMessageAt.getTime() < WHATSAPP_WINDOW_MS;

/**
 * What the Customer is told when an Officer arrives, and when they leave.
 *
 * **Never silent, in either direction.** Swapping a human for an AI without
 * saying so is a disclosure problem for a licensed institution, and this costs
 * two sentences. It is also the requirement behind Officer display names: the
 * Customer learns a staff member's first name, which is a small requirement with
 * a real consequence and is recorded rather than assumed.
 */
export const HANDOFF_WORDS = {
  officerArrived: (officer: string, bank: string): string =>
    `You're now speaking with ${officer} from ${bank}.`,
  officerResolved: (officer: string): string =>
    `${officer} has closed this chat — I'm back if you need anything else.`,
} as const;

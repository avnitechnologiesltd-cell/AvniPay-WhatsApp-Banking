/**
 * What the Middleware answers when the Platform submits an Intent.
 *
 * A closed union, like the Intent itself, and deliberately thin. It carries
 * what a reply needs and **no diagnostic detail** — the Platform is the
 * prompt-injection surface, so BankOne's own words about a failure go to the
 * operational log and the audit table, where a Support Officer can reach them,
 * rather than into the layer a Customer's text is read by.
 */

import type { TransactionPeriod } from "./period";

/** Naira. Already through the adapter, so never a raw BankOne string. */
export interface BalanceOutcome {
  readonly kind: "balance";
  readonly availableBalance: number;
  readonly ledgerBalance: number;
  readonly withdrawableBalance: number;
}

/**
 * One thing that happened on the account.
 *
 * `direction` rather than a signed amount, because a minus sign is a rendering
 * decision and *money in or money out* is the fact. The adapter reads whichever
 * BankOne sent and answers in these terms.
 *
 * **`narration` is text the Middleware did not write.** Anyone who can send a
 * Customer ₦100 can choose what it says, so it is rendered to the Customer and
 * shown to no model — the same rule `said` lives under, applied to money.
 */
export interface TransactionRow {
  /** Naira, and always positive. Which way it went is `direction`. */
  readonly amount: number;
  readonly direction: TransactionDirection;
  /**
   * ISO 8601, or absent where BankOne sent a date the Middleware would not
   * guess at — `20/08/2026` is either the 20th of August or the 8th of the
   * 20th month, and a date the platform invented is not a date.
   */
  readonly occurredAt: string | undefined;
  readonly narration: string | undefined;
}

/** Money in, or money out. Never a sign — a sign is a rendering decision. */
export type TransactionDirection = "credit" | "debit";

/**
 * What happened on the account, over the window the Customer asked for.
 *
 * An empty `rows` is an answer, not a failure: *nothing happened* is a true
 * thing to tell somebody, and it is not the same as `not_available`.
 */
export interface TransactionsOutcome {
  readonly kind: "transactions";
  readonly period: TransactionPeriod;
  readonly rows: readonly TransactionRow[];
}

/**
 * The operation exists but the Bank's token does not carry it — transaction
 * history against the first deployment today. Distinct from `failed`, because a Customer
 * is told something true and different: not *"something went wrong"* but
 * *"I cannot get that"*.
 */
export interface NotAvailableOutcome {
  readonly kind: "not_available";
}

/** No live Binding for this channel identity. The Customer needs to enroll. */
export interface NotIdentifiedOutcome {
  readonly kind: "not_identified";
}

/**
 * A **Mandate** is waiting, and the Customer must see it and enter their
 * Transaction PIN before anything moves.
 *
 * Two opaque strings, and deliberately nothing else. The amount, the
 * destination, the recipient's name from name enquiry and the source account
 * are all on the Confirmation screen, which the Middleware renders **inside the
 * sealed surface** — none of it passes through the layer that reads Customer
 * text into a model ([ADR-0007](../../../docs/adr/0007-flow-confirmations-terminate-at-the-middleware.md)).
 * The Platform is a courier that cannot open the envelope, and this type is what
 * makes that structural rather than a matter of care.
 */
export interface AuthorisationRequiredOutcome {
  readonly kind: "authorisation_required";
  /** Minted by the Middleware. Names the Mandate; opaque to everyone else. */
  readonly token: string;
  /** Which published Flow to open. WABA-scoped, so it is configuration. */
  readonly flowId: string;
  /** Where a Widget posts this surface. See {@link SealedSurfaceAddress}. */
  readonly surfaceUrl: string;
}

/**
 * **Where the sealed surface lives, on each Channel that has one.**
 *
 * `flowId` names a published Flow and `surfaceUrl` names an address; WhatsApp
 * reads the first, the Widget reads the second, and the Platform between them
 * reads neither. Both travel on every outcome because the courier is not told
 * which Channel it is on — carrying one field and choosing it here would be the
 * Channel branch this design spends everything to avoid.
 *
 * The address is the **Middleware's own**, which is the whole of ADR-0007 made
 * into a value: the Platform serves the Widget and then hands it somewhere else
 * to send the Transaction PIN. Nothing here is a secret — it is a public
 * endpoint — and it comes from the Middleware because the Platform is not
 * configured with it and should not be.
 */
export type SealedSurfaceAddress = Pick<
  AuthorisationRequiredOutcome,
  "token" | "flowId" | "surfaceUrl"
>;

/**
 * A sealed surface is open and **it is not a Mandate**, because nothing has been
 * resolved yet: the Customer named somebody, and either several of their saved
 * recipients answer to that name or none do.
 *
 * Sibling to `authorisation_required` rather than a variant of it, and the
 * difference is what the Platform is allowed to say. *"Check the details and
 * enter your PIN"* is a lie in front of a screen that is still asking who was
 * meant, and it is a worse one in front of a screen that deletes.
 *
 * **What it does not carry is which of the two cases it is.** Whether a Customer
 * has five saved Musas or none is a fact about who they pay, and the layer that
 * reads their text into a model has no business holding it — which is the same
 * reason the rows themselves are rendered inside the envelope.
 */
export interface BeneficiaryChoiceRequiredOutcome {
  readonly kind: "beneficiary_choice_required";
  /** What the tap will do: propose a transfer, or remove a saved record. */
  readonly purpose: "transfer" | "forget";
  /** Minted by the Middleware. Names the walk; opaque to everyone else. */
  readonly token: string;
  readonly flowId: string;
  /** Where a Widget posts this surface. See {@link SealedSurfaceAddress}. */
  readonly surfaceUrl: string;
}

/**
 * Nothing the Customer has ever paid answers to the name they used.
 *
 * Only ever the answer to *"forget Musa"*. A **transfer** to a name nobody
 * matches does not end here — it opens the Disambiguation screen anyway, because
 * that screen carries an account-number form, and an empty store is not an error
 * but the ordinary state of every Customer's first transfer.
 */
export interface NoSuchBeneficiaryOutcome {
  readonly kind: "no_such_beneficiary";
}

/**
 * A saved recipient's account no longer resolves at the bank that holds it.
 *
 * Separate from `destination_unknown` because of what the Customer's next move
 * is. *"Check the number and try again"* is advice about digits they typed, and
 * here they typed none — they said a name, and the ten digits behind it are ones
 * this platform stored. Closed accounts are why this exists.
 */
export interface BeneficiaryUnreachableOutcome {
  readonly kind: "beneficiary_unreachable";
}

/**
 * Name enquiry did not confirm the destination, so no Mandate was built.
 *
 * Distinct from `failed` because the Customer can act on it: an account number
 * that does not resolve is usually a mistyped one, and *"check the number"* is a
 * truer thing to say than *"something went wrong"*. It carries no reason — why
 * BankOne declined is in the audit table.
 */
export interface DestinationUnknownOutcome {
  readonly kind: "destination_unknown";
}

/**
 * The bank the Customer named is not one the Middleware can route to.
 *
 * Separate from `destination_unknown`, and the Customer's next move is why: one
 * says *check the number*, and this one says *check the bank* — a Customer told
 * the first when the second is true retypes a correct account number forever.
 * The Middleware refuses rather than guessing at which bank was meant, because
 * on this path a guess is a guess about who gets paid.
 */
export interface BankUnknownOutcome {
  readonly kind: "bank_unknown";
}

/** Something went wrong. Why is in the audit table, not in this object. */
export interface FailedOutcome {
  readonly kind: "failed";
}

/** The Middleware understood the request and declines to act on it here. */
export interface UnsupportedOutcome {
  readonly kind: "unsupported";
}

export type IntentOutcome =
  | BalanceOutcome
  | TransactionsOutcome
  | AuthorisationRequiredOutcome
  | BeneficiaryChoiceRequiredOutcome
  | NoSuchBeneficiaryOutcome
  | BeneficiaryUnreachableOutcome
  | BankUnknownOutcome
  | DestinationUnknownOutcome
  | NotAvailableOutcome
  | NotIdentifiedOutcome
  | FailedOutcome
  | UnsupportedOutcome;

/**
 * Why there is **no sealed surface to open**, as a code rather than a sentence.
 *
 * It lives here, beside the outcome union, for the reason every type in this
 * file does: the Middleware is the only layer that knows the reason and the
 * Platform is the only layer that renders words, so the two must compile
 * against one closed set rather than agree by inspection.
 *
 * Free text was the obvious shape and was worse than useless — either the
 * Middleware's sentence is shown to a Customer, or it is ignored and the
 * Platform infers a reason from what the Customer *asked for*. It was the
 * second, and that inference was correct while there was one Channel and wrong
 * the moment there were two: *"I forgot my PIN"*, typed inside the Bank's own
 * application, was answered with a sentence about a phone number.
 */
export type SurfaceNotApplicable =
  /** No live Binding, so there is nothing to reset a PIN for. */
  | "no_binding"
  | "already_linked"
  /** In-app chat: the Bank's own application has already signed them in. */
  | "already_identified"
  /** In-app chat: no enrollment, so no code path by which a PIN is replaced. */
  | "pin_is_chosen_at_first_transfer";

/** What the Middleware answers when the Platform opens a conversation. */
export interface OpenedConversation {
  /**
   * Unguessable, and minted by the Middleware. The Platform quotes it on every
   * later call and never mints one — otherwise the component running the LLM
   * names its own security context.
   */
  readonly conversationId: string;
  /**
   * Whether this conversation reaches an account. A single bit, not the account
   * number: the Support Agent needs to know *whether* it is speaking to an
   * identified Customer because that gates what it may say, and carrying the
   * value would walk an account number through the Platform on every message.
   */
  readonly identified: boolean;
}

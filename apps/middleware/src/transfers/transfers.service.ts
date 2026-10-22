import { Inject, Injectable, Logger } from "@nestjs/common";

import type { MiddlewareConfig } from "@avni/config";
import {
  formatNaira,
  type ForgetBeneficiaryIntent,
  type IntentOutcome,
  type SealedSurfaceAddress,
  type TransferToAccountIntent,
  type TransferToBeneficiaryIntent,
} from "@avni/intent";
import { CLOCK, type Clock } from "@avni/service";

import type { NameEnquiryOutcome } from "../bankone/adapter";
import type { Beneficiary } from "../beneficiaries/beneficiaries.repository";
import { isValidationFailure, type TransferResult } from "../bankone/transfers";
import { readText, unavailableScreen, type FlowScreen } from "../flows/screen";
import { CHOOSE_A_PIN, PINS_DIFFER, pinProblem } from "../pin/transaction-pin";
import { widgetSurfaceUrl } from "../surfaces/address";

import { AuditRepository } from "../audit/audit.repository";
import { BankOneAdapter } from "../bankone/adapter";
import { BeneficiariesRepository } from "../beneficiaries/beneficiaries.repository";
import { labelProblem } from "../beneficiaries/label";
import { matchingBeneficiaries, normaliseName } from "../beneficiaries/matching";
import { asRow, nameOf } from "../beneficiaries/row";
import { ConversationsService, type Channel } from "../identity/conversations.service";
import { NotificationsService } from "../notifications/notifications.service";
import { TransactionPinService } from "../pin/transaction-pin.service";
import { SettingsRepository } from "../settings/settings.repository";
import { chargeFor, feeInWords } from "../settings/tariff";
import { HandoffService } from "../support/handoff.service";
import { BANKONE_ADAPTER, MIDDLEWARE_CONFIG } from "../tokens";
import { MandatesRepository, type Mandate, type ProposedTransfer } from "./mandates.repository";
import { isIntraBank, resolveBank, type DestinationBank } from "./routing";
import { WalksRepository, type TransferWalk } from "./walks.repository";

/**
 * Sending money: resolve, confirm, take the PIN, dispatch, and say what
 * happened — all of it inside the Middleware.
 *
 * ## The rule this whole slice exists to enforce
 *
 * **The payload may carry what the Customer newly supplies; it must never carry
 * back a value the server rendered.** A Flow encrypts with a key the *client*
 * generates, so the handset owns that plaintext entirely. The published prior-art
 * Flow echoes `amount`, `account_number`, `bank` and `recipient_name` back from
 * its confirmation screen, and the attack is concrete: the Customer approves
 * ₦5,000, ₦900,000 reaches a fraudster, with a correct PIN and an honest
 * confirmation screen in between.
 *
 * So the only thing read out of a payload here is the **Transaction PIN**. The
 * token names a Mandate; every value the transfer uses is read back from that
 * row. A tampered `amount` or `account_number` has nowhere to go — not because
 * it is checked and rejected, but because nothing looks at it.
 *
 * ## The three rules a reader should not have to infer
 *
 * **Every transfer takes the PIN.** There is no confirm-only tier and no amount
 * below which it is skipped. The Binding lives on a handset, and a tier that
 * moves money at one tap is an unlocked stolen phone moving money at one tap.
 *
 * **`destinationName` is the name enquiry's, always.** Never a Beneficiary's
 * saved label, which is a string the Customer typed once and an attacker would
 * happily supply.
 *
 * **Pending is an answer.** BankOne is entitled to say *not yet*, and the
 * platform is never entitled to upgrade that to *yes*. Past the poll bound the
 * Customer is told it is being followed up, and Handoff trigger 1 fires.
 *
 * **Which endpoint moves the money is decided here, from the bank code alone.**
 * The Intent has no inter-bank variant and never will: splitting the two
 * upstream would put a BankOne implementation detail in the LLM's job. The bank
 * a Customer named becomes a NIBSS code before anything else happens, and the
 * code is what `dispatch` reads — off the stored Mandate, hours later, to the
 * same answer.
 */

/**
 * A screen of the send-money Flow.
 *
 * `RECIPIENT` is the **Disambiguation screen**, and keeps that name because it
 * is a screen id on the wire rather than a word in this codebase's vocabulary —
 * the published Flow calls it that, and renaming it here would leave the two
 * disagreeing about which screen a `data_exchange` names. Everywhere the *record*
 * is meant, the word is Beneficiary.
 */
export interface TransferScreen extends FlowScreen {
  readonly screen: "RECIPIENT" | "CONFIRM" | "DONE" | "LOCKED" | "UNAVAILABLE";
}

/**
 * What resolving a destination produced: a proposal waiting for a PIN, or the
 * one of three ways it can fail to become one.
 *
 * The refusals are named after the `IntentOutcome`s they usually become, because
 * on the conversational path they are handed straight through. On the
 * Disambiguation screen they become an error beside the list instead — the
 * Customer is already looking at somewhere else to try.
 */
type Proposal =
  | { readonly outcome: "proposed"; readonly token: string; readonly proposed: ProposedTransfer }
  | { readonly outcome: "destination_unknown" | "not_available" | "failed" };

/**
 * Everything the Confirmation screen sends up, and **nothing else exists**.
 *
 * Three strings a Customer typed. Named as a type rather than as three
 * arguments so that the day a fourth field is wanted, adding it is a decision
 * somebody has to write down here beside the rule about what a payload may
 * carry — rather than one more positional parameter nobody reads.
 */
export interface SuppliedOnConfirm {
  readonly pin: string;
  /** Only ever read where a PIN is being **created**. Empty otherwise. */
  readonly pinConfirmation: string;
  /** The optional *"Save as"* label. An absent one is ordinary. */
  readonly saveAs: string;
}

/** The PIN passed, or here is the screen that says why it did not. */
type PinGate =
  | { readonly outcome: "accepted" }
  | { readonly outcome: "refused"; readonly screen: TransferScreen };

/** Shape only. Name enquiry is the real check, and it is the next thing to run. */
const isTenDigits = (accountNumber: string): boolean => /^\d{10}$/.test(accountNumber);

/** What the Customer reads, in the words they will see. */
export const TRANSFER_WORDS = {
  // **The fee line is not here.** It is composed from the Bank's own tariff in
  // `settings/tariff.ts`, including the sentence said when the Bank has entered
  // none — because that fallback is a property of the tariff rather than of this
  // screen, and a second copy of it here would be a second thing to keep true.
  /**
   * **Both names, before the PIN.** A changed name is the clearest available
   * signal that an account has changed hands, and it costs nothing on any
   * transfer. Refusing outright was rejected — banks rename accounts for boring
   * reasons — and showing only the live name throws the signal away.
   */
  nameChanged: (now: string, atSave: string) =>
    `This account is now ${now}. It was ${atSave} when you saved it.`,
  checkAccountNumber: "I could not find that account. Please check the number.",
  checkBank: "I do not recognise that bank. Please check the name.",
  notTenDigits: "An account number is ten digits.",
  chooseSomebody: "Please choose somebody, or enter an account number.",
  chooseToRemove: "Please choose who to remove.",
  gone: "That one is no longer saved.",
  forgotten: (name: string) => `${name} is no longer saved.`,
  expired: "This transfer has expired. Please start again.",
  alreadyAuthorised: "You have already authorised this transfer. Start again to send another.",
  noPin: "You need a Transaction PIN before you can send money.",
  wrongPin: "That PIN is not right.",
  attemptsLeft: (left: number) => `${left} ${left === 1 ? "attempt" : "attempts"} left.`,
  lockedOut: "Too many attempts. Please try again in an hour.",
  succeeded: (amount: string, name: string, reference: string) =>
    `Sent ${amount} to ${name}. Reference ${reference}.`,
  failed: (amount: string, name: string) =>
    `Your transfer of ${amount} to ${name} did not go through.`,
  /** Never *"it worked"*, and never *"it failed"*. We do not know which. */
  followingUp: (amount: string, name: string) =>
    `Your transfer of ${amount} to ${name} has not been confirmed yet. ` +
    "We are following it up and will come back to you.",
} as const;

/**
 * A Mandate that has not been authorised expires after **3 hours**.
 *
 * Long, deliberately. Staleness cannot cause a wrong debit — the destination
 * account does not change, only the displayed name and balance go stale, and
 * BankOne re-checks funds at execution. The Customer needs their PIN regardless,
 * so an old confirmation screen is an inconvenience rather than a risk.
 */
const MANDATE_LIFETIME_MS = 3 * 60 * 60 * 1000;

/**
 * The inline poll: first query at 3 seconds, then every 3, giving up at 20.
 *
 * Nigerian settlement is measured in seconds and intra-bank is immediate, so the
 * Customer is still in the conversation and is answered in the same turn. **The
 * bound is a starting value, not a finding** — TSQ is unexercised against
 * BankOne (Appendix A.5) and this wants re-measuring against a real deployment
 * that returns pending.
 */
const FIRST_QUERY_MS = 3_000;
const QUERY_INTERVAL_MS = 3_000;
const POLL_BOUND_MS = 20_000;

/** What BankOne is told the transfer is for. Nothing a Customer supplied. */
const NARRATION = "Transfer";

/**
 * BankOne's response code for an audit row, where it gave one.
 *
 * Absent on an `unknown`, and that absence is the row telling the truth: a
 * dispatch nobody answered has no code because BankOne never said anything about
 * it. The two writers below share this so the two rows about one transfer cannot
 * come to disagree about what was said.
 */
const saidCode = (result: TransferResult): Readonly<Record<string, string>> =>
  result.outcome !== "unknown" && result.code ? { responseCode: result.code } : {};

/**
 * How each name enquiry ending is recorded. `unresolved` is a **refusal** rather
 * than a failure: BankOne answered perfectly and the answer was *no such
 * account*, which is usually a Customer who mistyped a digit.
 */
const ENQUIRY_OUTCOMES = {
  resolved: "succeeded",
  unresolved: "refused",
  unavailable: "unavailable",
  failed: "failed",
} as const;

/**
 * How each way a transfer can end is recorded.
 *
 * `pending` and `unknown` are both `unavailable` rather than `failed`, and that
 * is the audit table repeating what the code says: the platform does not know
 * what happened to this money, which is not the same claim as it not having
 * moved. One map rather than a conditional at each writer, so the two rows about
 * one transfer cannot come to disagree.
 */
const TRANSFER_OUTCOMES = {
  succeeded: "succeeded",
  failed: "failed",
  pending: "unavailable",
  unknown: "unavailable",
} as const;

@Injectable()
export class TransfersService {
  private readonly logger = new Logger(TransfersService.name);

  public constructor(
    @Inject(MandatesRepository) private readonly mandates: MandatesRepository,
    @Inject(WalksRepository) private readonly walks: WalksRepository,
    @Inject(BeneficiariesRepository) private readonly beneficiaries: BeneficiariesRepository,
    @Inject(TransactionPinService) private readonly pins: TransactionPinService,
    @Inject(BANKONE_ADAPTER) private readonly bankOne: BankOneAdapter,
    @Inject(ConversationsService) private readonly conversations: ConversationsService,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
    @Inject(AuditRepository) private readonly audit: AuditRepository,
    @Inject(MIDDLEWARE_CONFIG) private readonly config: MiddlewareConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(HandoffService) private readonly handoff: HandoffService,
    @Inject(SettingsRepository) private readonly settings: SettingsRepository,
  ) {}

  // --- Resolving what was asked for ------------------------------------------

  /**
   * Turns an Intent into a Mandate waiting for a PIN, or into an honest refusal.
   *
   * Nothing here moves money and nothing here is authorised. What comes back to
   * the Platform is two opaque strings — the amount, the destination and the
   * name that account holds are rendered inside the sealed surface, which is the
   * only place they belong.
   */
  public async begin(
    conversationId: string,
    sourceAccount: string,
    intent: TransferToAccountIntent,
  ): Promise<IntentOutcome> {
    // **Where intra- and inter-bank part company, and the only place they do.**
    // The Intent carries no variant for it and the Customer never said which
    // kind of transfer this is — the bank they named becomes a NIBSS code here,
    // and from there the code decides everything.
    //
    // A bank neither this Bank nor the directory recognises is refused. Routing
    // it on a guess would send another bank's account number to whoever holds
    // that number at whichever bank the guess landed on.
    const bank = resolveBank(intent.bankName, this.us());
    if (!bank) {
      await this.refuseIntent(conversationId, sourceAccount, intent.kind, {
        reason: "the bank the Customer named is not one this Middleware can route to",
        bankName: intent.bankName,
      });
      return { kind: "bank_unknown" };
    }

    const destinationAccount = intent.accountNumber.replace(/\s+/g, "");
    if (!isTenDigits(destinationAccount)) {
      // Shape only. The NUBAN check digit is not applied to a *destination*: the
      // weight vector is reproduced from the prototype and unconfirmed against
      // the CBN circular, and name enquiry is the real check either way. A local
      // rule that rejected a valid account would be a Customer who cannot pay
      // anyone, for a mistake of ours.
      await this.refuseIntent(conversationId, sourceAccount, intent.kind, {
        reason: "that is not the shape of an account number",
      });
      return { kind: "destination_unknown" };
    }

    const proposal = await this.propose({
      conversationId,
      sourceAccount,
      destinationAccount,
      bank,
      amount: intent.amount,
    });

    return proposal.outcome === "proposed"
      ? this.authorisationRequired(proposal.token)
      : { kind: proposal.outcome };
  }

  /**
   * *"Send 5000 to Musa"* — the flagship interaction, and the reason this
   * product is not a USSD menu.
   *
   * **Resolving a saved recipient decides what is *offered*, never what is
   * *sent*.** All three answers below end at the same Confirmation screen and
   * the same Transaction PIN; what differs is only how many screens come first.
   *
   * | matches | what happens |
   * | --- | --- |
   * | none | the Flow's account-number form — **every Customer's first transfer** |
   * | one | straight to the Confirmation screen |
   * | several | the Disambiguation screen, most-recently-used first, capped |
   *
   * The empty store is the normal case on day one and cannot be seeded:
   * transaction history is not entitled on the Bank's token, so there is no
   * history to mine. This Intent lights up on a Customer's *second* transfer to
   * the same person.
   */
  public async beginByBeneficiary(
    conversationId: string,
    sourceAccount: string,
    intent: TransferToBeneficiaryIntent,
  ): Promise<IntentOutcome> {
    const matches = await this.resolveName(conversationId, sourceAccount, intent.beneficiaryName);

    // **One match still goes through a name enquiry and a Confirmation screen.**
    // The saved account is where the money would go and the saved name is not
    // evidence of who holds it now.
    const only = matches.length === 1 ? matches[0] : undefined;
    if (only) {
      const proposal = await this.propose({
        conversationId,
        sourceAccount,
        destinationAccount: only.accountNumber,
        bank: { code: only.bankCode, name: only.bankName },
        beneficiary: only,
        amount: intent.amount,
      });

      if (proposal.outcome === "proposed") return this.authorisationRequired(proposal.token);
      // A saved account that will not resolve is not a number the Customer
      // mistyped — they typed none. *"Check the number and try again"* is advice
      // about digits this platform stored, so it is not what they are told.
      return {
        kind:
          proposal.outcome === "destination_unknown"
            ? "beneficiary_unreachable"
            : proposal.outcome,
      };
    }

    // None and several are one screen, because that screen carries both a list
    // and an account-number form. Nothing about *which* of the two this is
    // crosses back to the Platform.
    const token = await this.walks.start({
      conversationId,
      sourceAccount,
      saidName: intent.beneficiaryName,
      purpose: "transfer",
      amount: intent.amount,
    });

    return { kind: "beneficiary_choice_required", purpose: "transfer", ...this.surfaceAt(token) };
  }

  /**
   * *"Forget Musa"* — the same screen, and a tap is what deletes.
   *
   * Reusing the Disambiguation screen is not a saving. Deletion becomes
   * something the Customer's handset confirms rather than something a model
   * decides, and two Musas are handled correctly for free — an LLM asked to
   * choose between them would be choosing which of a Customer's recipients to
   * destroy from a sentence somebody else may have written.
   */
  public async beginForget(
    conversationId: string,
    sourceAccount: string,
    intent: ForgetBeneficiaryIntent,
  ): Promise<IntentOutcome> {
    const matches = await this.resolveName(conversationId, sourceAccount, intent.beneficiaryName);

    // The one place an empty match set is answered in words rather than with a
    // screen. A transfer to nobody has an account-number form to fall back on;
    // a deletion of nobody has nothing to show and nothing to do.
    if (matches.length === 0) return { kind: "no_such_beneficiary" };

    const token = await this.walks.start({
      conversationId,
      sourceAccount,
      saidName: intent.beneficiaryName,
      purpose: "forget",
    });

    return { kind: "beneficiary_choice_required", purpose: "forget", ...this.surfaceAt(token) };
  }

  /**
   * What a Customer's own store answers to a name they said, and the row that
   * records it.
   *
   * **Recorded on every attempt**, because this is the one step in the platform
   * where words become somebody's account number by inference. *"I sent money to
   * the wrong Musa"* is the most common support call this feature will generate,
   * and it is unanswerable without a row saying what was said and how many
   * records answered to it.
   */
  private async resolveName(
    conversationId: string,
    sourceAccount: string,
    said: string,
  ): Promise<readonly Beneficiary[]> {
    const store = await this.beneficiaries.findAllFor(sourceAccount);
    const matched = matchingBeneficiaries(store, said);

    // **`succeeded` whatever the count, including zero.** The resolution ran and
    // answered; *nothing matched* is the ordinary state of every Customer's
    // first transfer, and a table in which every first transfer appears as a
    // refusal is a table nobody can read a real refusal out of. How many
    // answered is on the row, where it is a number rather than a verdict.
    await this.audit.record({
      action: "beneficiary.resolved",
      actor: { kind: "customer" },
      outcome: "succeeded",
      accountNumber: sourceAccount,
      conversationId,
      detail: { said, saved: store.length, matched: matched.length },
    });

    return matched;
  }

  /**
   * Name enquiry, the payer where one is needed, and the row the Customer is
   * about to be shown.
   *
   * Everything from here to the Confirmation screen is identical whether the
   * Customer typed ten digits, tapped a saved recipient or had exactly one.
   * **That sameness is the security property**: there is no confident path that
   * skips a screen, and no path on which a saved label is what gets shown.
   */
  private async propose(options: {
    readonly conversationId: string;
    readonly sourceAccount: string;
    readonly destinationAccount: string;
    readonly bank: DestinationBank;
    readonly amount: number;
    readonly beneficiary?: Beneficiary | undefined;
  }): Promise<Proposal> {
    const { conversationId, sourceAccount, destinationAccount, bank, beneficiary } = options;

    // **Under the destination bank's code**, which for another bank is an
    // interbank enquiry across NIBSS and is the only source of the `ReceiverName`
    // that endpoint requires. Same call, same field, a different code in it.
    const intra = isIntraBank(bank.code, this.config.bankOne.bankCode);

    const enquiry = await this.enquire({
      subject: "destination",
      accountNumber: destinationAccount,
      bankCode: bank.code,
      conversationId,
      customerAccount: sourceAccount,
    });

    if (enquiry.outcome === "unresolved") {
      this.logger.warn({ event: "name_enquiry_unresolved", conversationId, reason: enquiry.reason });
      return { outcome: "destination_unknown" };
    }
    if (enquiry.outcome === "unavailable") {
      this.logger.error({ event: "bankone_unavailable", conversationId, reason: enquiry.reason });
      return { outcome: "not_available" };
    }
    if (enquiry.outcome === "failed") {
      this.logger.error({ event: "name_enquiry_failed", conversationId, reason: enquiry.reason });
      return { outcome: "failed" };
    }

    // An inter-bank transfer must name its **payer**, and BankOne checks the
    // name against the sending account. Resolved here rather than at dispatch,
    // because a transfer that cannot be built is a Customer who should be told
    // so before they enter a PIN rather than after.
    let payerName: string | undefined;
    if (!intra) {
      const payer = await this.enquire({
        subject: "payer",
        accountNumber: sourceAccount,
        bankCode: this.config.bankOne.bankCode,
        conversationId,
        customerAccount: sourceAccount,
      });

      if (payer.outcome !== "resolved") {
        this.logger.error({
          event: "payer_name_unresolved",
          conversationId,
          reason: payer.reason,
        });
        // **`unresolved` is not `destination_unknown` here.** An account number
        // that will not resolve is actionable when it is the recipient's and the
        // Customer typed it; when it is the Customer's *own* account there is
        // nothing for them to correct, and telling them to check a number they
        // never gave is worse than telling them nothing.
        return { outcome: payer.outcome === "failed" ? "failed" : "not_available" };
      }
      payerName = payer.value.name;
    }

    const { token, proposed } = await this.mandates.create({
      conversationId,
      sourceAccount,
      destinationAccount,
      destinationBankCode: bank.code,
      destinationBank: bank.name,
      // **From name enquiry, always.** Never a Beneficiary's saved label, which
      // is a string the Customer typed once and an attacker would happily
      // supply — and never `nameAtSave`, which was true on the day it was saved
      // and is exactly the thing being checked.
      destinationName: enquiry.value.name,
      // Only where it is sent. An intra-bank transfer has no `ReceiverKYC`
      // field to fill, and keeping a third party's tier on a row that will never
      // use it is keeping somebody else's data for nothing.
      destinationKyc: intra ? undefined : enquiry.value.kyc,
      payerName,
      beneficiaryId: beneficiary?.id,
      savedName: beneficiary?.nameAtSave,
      amount: options.amount,
    });

    // The row an audit reconstructs a debit from. The recipient's *name* is not
    // in it — it belongs to somebody who is not this Bank's Customer, and the
    // reference ties this row to BankOne's own record of who was paid.
    await this.audit.record({
      action: "transfer.proposed",
      actor: { kind: "customer" },
      outcome: "succeeded",
      accountNumber: sourceAccount,
      conversationId,
      detail: {
        mandateId: proposed.id,
        reference: proposed.reference,
        destinationAccount,
        destinationBankCode: proposed.destinationBankCode,
        amount: proposed.amount,
        ...(beneficiary ? { beneficiaryId: beneficiary.id } : {}),
      },
    });

    return { outcome: "proposed", token, proposed };
  }

  private authorisationRequired(token: string): IntentOutcome {
    return { kind: "authorisation_required", ...this.surfaceAt(token) };
  }

  /**
   * Where the sealed surface for this token lives, on **both** Channels.
   *
   * A published Flow id and an address travel together on every outcome,
   * because **the Platform** is deliberately not told which Channel it is on —
   * WhatsApp's adapter reads the first, the Widget reads the second. Sending
   * one field and choosing it here would put a Channel branch in the composer,
   * which is the one place this design spends everything to keep it out of.
   *
   * The Middleware branches on the Channel where the Channel is genuinely the
   * subject — which door a token may be driven through, and where an outcome
   * is delivered. It does not branch on it to decide what a screen says.
   */
  private surfaceAt(token: string): SealedSurfaceAddress {
    return {
      token,
      flowId: this.config.whatsapp.flows.sendMoneyFlowId,
      surfaceUrl: widgetSurfaceUrl(this.config.publicBaseUrl),
    };
  }

  private async refuseIntent(
    conversationId: string,
    sourceAccount: string,
    kind: string,
    detail: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.audit.record({
      action: "intent.submitted",
      actor: { kind: "platform" },
      outcome: "refused",
      accountNumber: sourceAccount,
      conversationId,
      detail: { kind, ...detail },
    });
  }

  /** This Bank, as the two things routing is decided from. */
  private us(): DestinationBank {
    return { code: this.config.bankOne.bankCode, name: this.config.bankName };
  }

  /**
   * One name enquiry, and the row that records it.
   *
   * **Every one is recorded**, because it reads who holds an account — a
   * question about a third party rather than about the Customer asking it. The
   * `subject` is on the row for the same reason: an inter-bank transfer runs two
   * of these, one across NIBSS for the recipient and one at this Bank for the
   * payer, and an investigator should not have to work out from the account
   * numbers which was which.
   */
  private async enquire(options: {
    readonly subject: "destination" | "payer";
    /** The account being resolved — the recipient's, or the Customer's own. */
    readonly accountNumber: string;
    readonly bankCode: string;
    readonly conversationId: string;
    /** Whose row this is: the Customer the enquiry was run for. */
    readonly customerAccount: string;
  }): Promise<NameEnquiryOutcome> {
    const enquiry = await this.bankOne.nameEnquiry(options.accountNumber, options.bankCode);

    await this.audit.record({
      action: "banking.name_enquiry",
      actor: { kind: "customer" },
      outcome: ENQUIRY_OUTCOMES[enquiry.outcome],
      accountNumber: options.customerAccount,
      conversationId: options.conversationId,
      detail: {
        subject: options.subject,
        // The Customer's own account is already the row's `accountNumber`;
        // repeating it under a second name would suggest two accounts.
        ...(options.subject === "destination"
          ? { destinationAccount: options.accountNumber }
          : {}),
        bankCode: options.bankCode,
        ...(enquiry.outcome === "resolved" ? {} : { reason: enquiry.reason }),
      },
    });

    return enquiry;
  }

  // --- The sealed surface ----------------------------------------------------

  /**
   * The Confirmation screen, or nothing at all.
   *
   * `undefined` means *this token names no Mandate*, which is how the Flows
   * endpoint knows to offer the same exchange to enrollment. It is not an error
   * and it is not a refusal.
   */
  public async open(token: string | undefined): Promise<TransferScreen | undefined> {
    // **A walk is asked about first**, because a token that names one may name a
    // Mandate underneath it too, and the walk is the thing that knows whether
    // the Customer has chosen yet.
    const walk = await this.walks.findByToken(token);
    if (walk) return this.resume(walk);

    const proposed = await this.mandates.findByToken(token);
    if (!proposed) return undefined;

    return (await this.spent(proposed)) ?? (await this.confirm(proposed));
  }

  /**
   * Where a walk is: still choosing, or looking at a Confirmation screen.
   *
   * This is what a `BACK` lands on, and going back to the list after a
   * Confirmation screen is a thing a Customer legitimately does — they saw a
   * name they did not expect. Choosing again simply proposes again; the
   * abandoned proposal is unauthorised by construction and unreachable, because
   * nothing names it any more.
   */
  private async resume(walk: TransferWalk): Promise<TransferScreen> {
    if (this.tooOld(walk.createdAt)) return unavailableScreen(TRANSFER_WORDS.expired);

    const proposed = walk.mandateId ? await this.mandates.findById(walk.mandateId) : undefined;
    if (!proposed) return this.disambiguationScreen(walk);

    return (await this.spent(proposed)) ?? (await this.confirm(proposed));
  }

  /**
   * The **Disambiguation screen**: the Flow's own server-fed list, and an
   * account-number form beneath it.
   *
   * It lives in the Flow rather than in a WhatsApp list message the Platform
   * sends, and that is a security decision rather than a rendering one. A list
   * message would hand the Platform — the layer a Customer's text is read into a
   * model by — the names and accounts of everybody a Customer pays, and would
   * let an injected Platform reorder the rows to put a fraudulent Musa first.
   * The Confirmation screen would still catch it; there is no reason to accept
   * the exposure when a Flow does this natively.
   *
   * The list is re-read on every render rather than frozen when the walk began,
   * so a record forgotten in another conversation is not offered here.
   */
  private async disambiguationScreen(walk: TransferWalk, error?: string): Promise<TransferScreen> {
    const store = await this.beneficiaries.findAllFor(walk.sourceAccount);
    const rows = matchingBeneficiaries(store, walk.saidName).map(asRow);

    return {
      screen: "RECIPIENT",
      data: {
        // What a tap will do. The screen is the same one either way; what it
        // offers beneath the list is not.
        purpose: walk.purpose,
        beneficiaries: rows,
        // Shown so the Customer knows what they are choosing a recipient *for*.
        // It is rendered here and read back from the walk, never from a payload.
        ...(walk.amount === null ? {} : { amount: formatNaira(walk.amount) }),
        ...(error ? { error_message: error } : {}),
      },
      terminal: false,
    };
  }

  /**
   * The row the Customer tapped, or the account number they typed instead.
   *
   * **The tapped id is scoped to the Customer's own store**, which is what makes
   * accepting it safe. It is a value the server rendered coming back, and the
   * payload rule permits exactly that class — *a selection* — because what it
   * selects from is a set the server owns. An id belonging to somebody else's
   * store resolves to nothing at all.
   */
  public async chooseBeneficiary(
    token: string | undefined,
    data: Readonly<Record<string, unknown>>,
  ): Promise<TransferScreen | undefined> {
    const walk = await this.walks.findByToken(token);
    if (!walk) return undefined;

    if (this.tooOld(walk.createdAt)) return unavailableScreen(TRANSFER_WORDS.expired);

    // The same rule the PIN screen enforces: a surface must not outlive the
    // Binding that authorised opening it. A Customer who reports a stolen
    // handset has their Binding revoked in the middle of walks like this one.
    const account = await this.conversations.accountFor(walk.conversationId);
    if (account !== walk.sourceAccount) return unavailableScreen(TRANSFER_WORDS.expired);

    const chosen = readText(data, "beneficiary_id");

    if (walk.purpose === "forget") return this.forget(walk, chosen);

    if (chosen) {
      const beneficiary = await this.beneficiaries.findOwned(chosen, walk.sourceAccount);
      if (!beneficiary) return this.disambiguationScreen(walk, TRANSFER_WORDS.gone);

      return this.proposeFor(walk, {
        destinationAccount: beneficiary.accountNumber,
        bank: { code: beneficiary.bankCode, name: beneficiary.bankName },
        beneficiary,
      });
    }

    // The account-number form, which is where **every Customer's first
    // transfer** lands: a store that has never been written to matches nothing,
    // and there is no history to seed it from.
    const typed = readText(data, "account_number").replace(/\s+/g, "");
    if (typed.length === 0) return this.disambiguationScreen(walk, TRANSFER_WORDS.chooseSomebody);
    if (!isTenDigits(typed)) return this.disambiguationScreen(walk, TRANSFER_WORDS.notTenDigits);

    // Blank means this Bank, exactly as it does on the conversational path — a
    // Customer who names no bank means their own, and the Confirmation screen
    // says which one either way.
    const bank = resolveBank(readText(data, "bank_name"), this.us());
    if (!bank) return this.disambiguationScreen(walk, TRANSFER_WORDS.checkBank);

    return this.proposeFor(walk, { destinationAccount: typed, bank });
  }

  /** Proposes the destination a walk settled on, and shows it for confirmation. */
  private async proposeFor(
    walk: TransferWalk,
    destination: {
      readonly destinationAccount: string;
      readonly bank: DestinationBank;
      readonly beneficiary?: Beneficiary | undefined;
    },
  ): Promise<TransferScreen> {
    // A `transfer` walk carries an amount and the schema will not let it be
    // otherwise. Read rather than defaulted, because a zero here would be this
    // service inventing what a Customer asked to send.
    if (walk.amount === null) return unavailableScreen();

    const proposal = await this.propose({
      conversationId: walk.conversationId,
      sourceAccount: walk.sourceAccount,
      amount: walk.amount,
      ...destination,
    });

    if (proposal.outcome === "destination_unknown") {
      // Back to the list with a sentence, rather than out of the surface. The
      // Customer is already looking at somewhere else to try.
      return this.disambiguationScreen(walk, TRANSFER_WORDS.checkAccountNumber);
    }
    if (proposal.outcome !== "proposed") return unavailableScreen();

    await this.walks.resolvedTo(walk.id, proposal.proposed.id);
    return this.confirm(proposal.proposed);
  }

  /**
   * Removes the record the Customer tapped.
   *
   * The tap is the act. Nothing here was decided by the model that read
   * *"forget Musa"* — it named a search, and this deletes exactly the row a
   * Customer looked at and touched.
   */
  private async forget(walk: TransferWalk, chosen: string): Promise<TransferScreen> {
    if (!chosen) return this.disambiguationScreen(walk, TRANSFER_WORDS.chooseToRemove);

    const removed = await this.beneficiaries.forget(chosen, walk.sourceAccount);
    if (!removed) return this.disambiguationScreen(walk, TRANSFER_WORDS.gone);

    await this.audit.record({
      action: "beneficiary.forgotten",
      actor: { kind: "customer" },
      outcome: "succeeded",
      accountNumber: walk.sourceAccount,
      conversationId: walk.conversationId,
      detail: {
        beneficiaryId: removed.id,
        destinationAccount: removed.accountNumber,
        bankCode: removed.bankCode,
      },
    });

    return {
      screen: "DONE",
      data: { message: TRANSFER_WORDS.forgotten(nameOf(removed)) },
      terminal: true,
    };
  }

  /**
   * The PIN, and the only value this whole slice reads out of a payload.
   *
   * The order below is the order it has to be in. Expiry and replay are checked
   * **before** the PIN, so a Mandate that could never be authorised does not
   * spend one of the Customer's three attempts; the PIN is checked **before**
   * the Mandate is claimed, so a wrong PIN does not consume the transfer.
   */
  public async submitPin(
    token: string | undefined,
    supplied: SuppliedOnConfirm,
  ): Promise<TransferScreen | undefined> {
    const walk = await this.walks.findByToken(token);
    const proposed = walk?.mandateId
      ? await this.mandates.findById(walk.mandateId)
      : await this.mandates.findByToken(token);
    if (!proposed) return undefined;

    const spent = await this.spent(proposed);
    if (spent) return spent;

    const reachable = await this.stillReaches(proposed);
    if (reachable) return reachable;

    // **Checked before the PIN**, so a label a Customer has to retype does not
    // cost them one of three attempts at four digits. The field is optional and
    // an empty one is never a problem.
    const problem = labelProblem(supplied.saveAs);
    if (problem) return this.confirm(proposed, problem);

    const gate = await this.takePin(proposed, supplied);
    if (gate.outcome === "refused") return gate.screen;

    // **Where a proposal becomes a Mandate.** Single-use, claimed rather than
    // checked: two taps on the same screen race each other here, and the loser
    // must not be a second debit. Nothing below this line can be reached with an
    // unauthorised transfer, because nothing below this line accepts one.
    const mandate = await this.mandates.authorise(proposed.id);
    if (!mandate) {
      return this.refuse(proposed, "already authorised", TRANSFER_WORDS.alreadyAuthorised);
    }

    await this.audit.record({
      action: "mandate.authorised",
      actor: { kind: "customer" },
      outcome: "succeeded",
      accountNumber: mandate.sourceAccount,
      conversationId: mandate.conversationId,
      detail: { mandateId: mandate.id, reference: mandate.reference, amount: mandate.amount },
    });

    // **Saved at submission, not at settlement**, and this line is where that
    // decision lands. BankOne is entitled to answer *not yet final*, there is no
    // webhook, and polling may resolve hours later — so anything that waited for
    // settlement to write this record would be waiting past the end of the
    // conversation the Customer is in. What a confirmed failure does to it is
    // below.
    await this.remember(mandate, supplied.saveAs);

    return this.settle(mandate);
  }

  /**
   * Takes the Transaction PIN — or, for a Customer who has none, takes the one
   * they are choosing.
   *
   * **Which of the two it is, is decided by the PIN store and never by the
   * Channel.** That is what keeps this one surface: the Confirmation screen in
   * the Widget and the Confirmation screen in the Flow run the same code, and
   * the only reason a Customer sees two fields instead of one is that this
   * account has never had a PIN.
   */
  private async takePin(
    proposed: ProposedTransfer,
    supplied: SuppliedOnConfirm,
  ): Promise<PinGate> {
    return (await this.pins.isSet(proposed.sourceAccount))
      ? this.enterPin(proposed, supplied.pin)
      : this.createPin(proposed, supplied);
  }

  private async enterPin(proposed: ProposedTransfer, pin: string): Promise<PinGate> {
    const check = await this.pins.verify(proposed.sourceAccount, pin, {
      conversationId: proposed.conversationId,
    });

    switch (check.outcome) {
      case "verified":
        return { outcome: "accepted" };

      case "locked_out":
        // The counter is on the **Customer**, not on this Mandate, and it is
        // shared with Gated Connector attempts. Starting a fresh transfer does
        // not buy three more guesses at four digits.
        return {
          outcome: "refused",
          screen: { screen: "LOCKED", data: { message: TRANSFER_WORDS.lockedOut }, terminal: true },
        };

      case "not_set":
        // Only reachable if a PIN went away between the line above and this
        // one. Nothing removes one today; it is answered rather than assumed
        // away, because *"you have no PIN"* must never be an invitation to set
        // one on a path that did not check whether one already existed.
        return { outcome: "refused", screen: unavailableScreen(TRANSFER_WORDS.noPin) };

      case "wrong":
        return {
          outcome: "refused",
          screen: await this.confirm(
            proposed,
            `${TRANSFER_WORDS.wrongPin} ${TRANSFER_WORDS.attemptsLeft(check.attemptsLeft)}`,
          ),
        };
    }
  }

  /**
   * **Enrollment's last step, minus the OTP** — and the reason the Widget's
   * authorisation surface had to terminate at the Middleware even more plainly
   * than a Flow's does.
   *
   * A Customer who has only ever used in-app chat never enrolled, so there is
   * no code to send and nobody to send it to: the Bank's own application signed
   * them in and its backend signed who they are, which is the authentication an
   * OTP would otherwise have to supply (ADR-0010). What is left is the part
   * that was never about authentication — choosing four digits, twice.
   *
   * Set **before** the Mandate is authorised and kept whatever becomes of the
   * transfer. The PIN is the Customer's, not this transfer's; a Customer who
   * chose one and then had BankOne decline the payment must not be asked to
   * choose again.
   */
  private async createPin(
    proposed: ProposedTransfer,
    supplied: SuppliedOnConfirm,
  ): Promise<PinGate> {
    const problem = pinProblem(supplied.pin);
    if (problem) return { outcome: "refused", screen: await this.confirm(proposed, problem) };

    if (supplied.pin !== supplied.pinConfirmation) {
      return { outcome: "refused", screen: await this.confirm(proposed, PINS_DIFFER) };
    }

    await this.pins.set(proposed.sourceAccount, supplied.pin, {
      reason: "set at a first transfer, on a Channel with no enrollment",
      mandateId: proposed.id,
    });

    return { outcome: "accepted" };
  }

  /**
   * Records the recipient a Customer has just authorised paying.
   *
   * **There is no save-without-paying.** Every record in the store was created
   * behind a Transaction PIN, so planting one costs an attacker a completed,
   * authorised transfer rather than a single injected instruction — and the
   * label they would plant it under is shown as a label, never as the name on
   * the Confirmation screen.
   */
  private async remember(mandate: Mandate, saveAs: string): Promise<void> {
    const record = await this.beneficiaries.save({
      ownerAccount: mandate.sourceAccount,
      accountNumber: mandate.destinationAccount,
      bankCode: mandate.destinationBankCode,
      bankName: mandate.destinationBank,
      // The bank's own name for the account, as it stood at this moment. It is
      // what a later transfer's name enquiry is compared against.
      nameAtSave: mandate.destinationName,
      label: saveAs,
      mandateId: mandate.id,
    });

    await this.audit.record({
      action: "beneficiary.saved",
      actor: { kind: "customer" },
      outcome: "succeeded",
      accountNumber: mandate.sourceAccount,
      conversationId: mandate.conversationId,
      detail: {
        beneficiaryId: record.id,
        mandateId: mandate.id,
        destinationAccount: record.accountNumber,
        bankCode: record.bankCode,
        // Whether this transfer created the record, which is what decides
        // whether a later failure removes it.
        created: record.createdByMandateId === mandate.id,
        // **Whether there is a label, never the label itself.** It is a
        // Customer's own word for a third party, and the audit table is the
        // worst place to accumulate one.
        labelled: record.label.length > 0,
      },
    });
  }

  // --- Moving the money ------------------------------------------------------

  /** Dispatches once, polls inline, and tells the Customer what happened. */
  private async settle(mandate: Mandate): Promise<TransferScreen> {
    const result = await this.dispatch(mandate);
    const final =
      result.outcome === "succeeded" || result.outcome === "failed"
        ? result
        : await this.poll(mandate);

    const amount = formatNaira(mandate.amount);

    if (final.outcome === "succeeded") {
      await this.finish(mandate, "succeeded", final);
      return this.tell(
        mandate,
        TRANSFER_WORDS.succeeded(amount, mandate.destinationName, mandate.reference),
      );
    }

    if (final.outcome === "failed") {
      // **Three endings, and the Customer hears two of them.** A business
      // decline and a malformed request both mean the money stayed, and both are
      // told the same true sentence — but only one of them is a defect of ours,
      // so the Bank is told which. The third, a dispatch nobody answered, is
      // below and is not a failure at all.
      //
      // A failure BankOne gave **no code for** is logged as ours too: an
      // entitlement that is switched off, an endpoint this deployment does not
      // serve, a body nobody could read. None of those is somebody declining a
      // transfer, and none of them gets quieter for being rare.
      const ours = isValidationFailure(final) || !final.code;
      this.logger[ours ? "error" : "warn"]({
        event: ours ? "transfer_rejected_as_invalid" : "transfer_declined",
        reference: mandate.reference,
        conversationId: mandate.conversationId,
        responseCode: final.code,
        reason: final.reason,
      });
      await this.finish(mandate, "failed", final);

      // **A Beneficiary is a by-product of a transfer that happened.** A
      // confirmed failure means it did not, so the record this transfer created
      // goes with it — and *only* the one it created. A second payment to
      // somebody already saved leaves their record standing, because that record
      // was not this transfer's to remove.
      //
      // `pending` deliberately does not reach here. The platform does not know
      // what happened to that money, and deleting on a guess would be the
      // platform acting on a claim it has just told the Customer it cannot make.
      //
      // **So "confirmed failed" means confirmed within the turn**, which is
      // every failure this release can observe: a transfer that passes the poll
      // bound fires Handoff trigger 1 and is picked up by a Support Officer, and
      // nothing in this release settles a pending transfer afterwards. When
      // something does, it calls `forgetCreatedBy` with that Mandate's id and
      // this rule holds unchanged — which is why the record carries the id
      // rather than a flag this branch sets.
      const forgotten = await this.beneficiaries.forgetCreatedBy(mandate.id);
      if (forgotten) {
        await this.audit.record({
          action: "beneficiary.forgotten",
          actor: { kind: "system" },
          outcome: "succeeded",
          accountNumber: mandate.sourceAccount,
          conversationId: mandate.conversationId,
          detail: {
            beneficiaryId: forgotten.id,
            mandateId: mandate.id,
            reason: "the transfer that created it was confirmed failed",
          },
        });
      }

      return this.tell(mandate, TRANSFER_WORDS.failed(amount, mandate.destinationName));
    }

    // Neither answer. **Handoff trigger 1**: money may have left the Customer's
    // account and the platform cannot say where it went, which is the one
    // trigger that never queues and never waits for business hours. It goes into
    // the Inbox at the top and **also** pages the Bank's operations desk, so it
    // is never sitting silently at 3am. The Customer is told the truth either
    // way, which is the part that must not wait for anything.
    await this.finish(mandate, "pending", final);
    this.logger.error({
      event: "transfer_unresolved",
      reference: mandate.reference,
      conversationId: mandate.conversationId,
      reason: final.reason,
    });

    await this.handoff.raise(
      mandate.conversationId,
      "pending_transfer",
      `A transfer of ${amount} to ${mandate.destinationName} is unresolved. ` +
        `BankOne last said: ${final.reason ?? "nothing"}.`,
      {
        mandateId: mandate.id,
        reference: mandate.reference,
        // What BankOne last said, so the Officer picking this up starts from
        // the same fact the platform gave up on.
        lastAnswer: final.reason,
      },
    );

    return this.tell(mandate, TRANSFER_WORDS.followingUp(amount, mandate.destinationName));
  }

  /**
   * The one dispatch a Mandate gets.
   *
   * A second one is not attempted **even when the first told us nothing**. That
   * is the whole of "a retried dispatch never debits twice": BankOne guarantees
   * no idempotency on the reference (Appendix A.5), so a request that landed and
   * whose response was lost would be performed twice. The status query on the
   * same reference is how the platform finds out instead of guessing.
   */
  private async dispatch(mandate: Mandate): Promise<TransferResult> {
    // **Which endpoint, from the stored bank code and nothing else.** The same
    // comparison that ran when the transfer was proposed, against the same
    // value, which is why an authorisation three hours later cannot come out the
    // other way.
    const intra = isIntraBank(mandate.destinationBankCode, this.config.bankOne.bankCode);

    // Checked **before** the dispatch is claimed, so a Mandate that cannot be
    // built is not marked as having been sent. It cannot happen for a Mandate
    // this release proposed — the payer is resolved before the Confirmation
    // screen — and it is here because the column is nullable and a wrong `Payer`
    // is a transfer BankOne declines after taking it.
    if (!intra && !mandate.payerName) {
      this.logger.error({ event: "inter_bank_mandate_without_payer", reference: mandate.reference });
      return { outcome: "failed", reason: "this Mandate carries no payer name" };
    }

    if (!(await this.mandates.claimDispatch(mandate.id))) {
      this.logger.warn({ event: "dispatch_already_claimed", reference: mandate.reference });
      return { outcome: "unknown", reason: "this Mandate had already been dispatched" };
    }

    const instruction = {
      fromAccountNumber: mandate.sourceAccount,
      toAccountNumber: mandate.destinationAccount,
      amount: mandate.amount,
      reference: mandate.reference,
      narration: NARRATION,
    };

    const result = intra
      ? await this.bankOne.intraBankTransfer(instruction)
      : await this.bankOne.interBankTransfer({
          ...instruction,
          toBankCode: mandate.destinationBankCode,
          // The name enquiry's, read back off the row the Customer confirmed.
          toAccountName: mandate.destinationName,
          toKyc: mandate.destinationKyc ?? undefined,
          fromAccountName: mandate.payerName ?? "",
        });

    await this.audit.record({
      action: "mandate.dispatched",
      actor: { kind: "system" },
      outcome: TRANSFER_OUTCOMES[result.outcome],
      accountNumber: mandate.sourceAccount,
      conversationId: mandate.conversationId,
      detail: {
        mandateId: mandate.id,
        reference: mandate.reference,
        amount: mandate.amount,
        // Which endpoint carried it, in the platform's own words rather than
        // BankOne's. A reconciliation against NIBSS starts from these rows.
        route: intra ? "intra_bank" : "inter_bank",
        destinationBankCode: mandate.destinationBankCode,
        result: result.outcome,
        ...saidCode(result),
        ...(result.reason ? { reason: result.reason } : {}),
      },
    });

    return result;
  }

  /**
   * Asks BankOne what became of the reference, on a schedule the Customer waits
   * through.
   *
   * The status query is read from `ResponseCode`/`Status` only — its
   * `IsSuccessful` reports whether the *query* ran, and has been observed set
   * beside `Status: "Failed"`. That reading lives in the adapter; what lives here
   * is when to stop asking.
   */
  private async poll(mandate: Mandate): Promise<TransferResult> {
    let waited = 0;

    for (;;) {
      const next = waited === 0 ? FIRST_QUERY_MS : QUERY_INTERVAL_MS;
      if (waited + next > POLL_BOUND_MS) {
        return {
          outcome: "pending",
          reason: `no final answer within ${POLL_BOUND_MS / 1000} seconds`,
        };
      }

      await this.clock.sleep(next);
      waited += next;

      const status = await this.bankOne.transactionStatus(mandate.reference);
      if (status.outcome === "succeeded" || status.outcome === "failed") return status;
    }
  }

  /**
   * The last word on a Mandate, in the table the Bank reconstructs a debit from.
   *
   * `answer` is what BankOne last said, and its response code goes on the row:
   * *the transfer failed* is what the Customer is told, and **why** is what an
   * investigation needs — a `96` and a `12` are a decline and a defect.
   */
  private async finish(
    mandate: Mandate,
    outcome: "succeeded" | "failed" | "pending",
    answer: TransferResult,
  ): Promise<void> {
    await this.mandates.settle(mandate.id, outcome);
    await this.audit.record({
      action: "mandate.settled",
      actor: { kind: "system" },
      outcome: TRANSFER_OUTCOMES[outcome],
      accountNumber: mandate.sourceAccount,
      conversationId: mandate.conversationId,
      detail: {
        mandateId: mandate.id,
        reference: mandate.reference,
        amount: mandate.amount,
        result: outcome,
        ...saidCode(answer),
        ...(answer.reason ? { reason: answer.reason } : {}),
      },
    });
  }

  // --- Screens ---------------------------------------------------------------

  /**
   * The Confirmation screen: the amount, where it is going, whose name that
   * account is in, and where it is coming from.
   *
   * Every value is read from the Mandate and rendered here. **None of it is sent
   * back**, and the Flow that renders it must not echo it — that echo is the
   * ₦900,000 attack, and it is the reason these Flows are republished rather
   * than reused.
   */
  private async confirm(proposed: ProposedTransfer, error?: string): Promise<TransferScreen> {
    // **Whether this Customer has a Transaction PIN at all.** A Customer who has
    // only ever used in-app chat never enrolled and so has none, and this screen
    // is where they get one — enrollment's last step minus the OTP, because the
    // Bank's own application has already done that authentication (ADR-0010).
    //
    // Asked from the PIN store rather than from the Channel, which is what
    // keeps it one surface rather than two. On WhatsApp the answer is always
    // `enter`: a Binding and a PIN are written in the same transaction, so a
    // Binding with no PIN behind it is a state enrollment cannot leave.
    const setting = !(await this.pins.isSet(proposed.sourceAccount));

    return {
      screen: "CONFIRM",
      data: {
        amount: formatNaira(proposed.amount),
        destination_name: proposed.destinationName,
        destination_account: proposed.destinationAccount,
        destination_bank: proposed.destinationBank,
        source_account: proposed.sourceAccount,
        fee_note: await this.feeNote(proposed),
        // **Present only when there is a PIN to create**, which makes the
        // absent case mean *ask for four digits once* and leaves this screen's
        // payload byte-identical to what it was on the Channel that can never
        // reach the other case.
        //
        // That is not tidiness. The Flow is published Meta-side and validates a
        // `data_exchange` response against the screen's declared model; whether
        // an undeclared key is tolerated is not something this repository can
        // establish, and a key that is always the same value buys nothing to
        // find out with. **Worth revisiting against a published Flow** — the
        // same open question ticket 33 recorded about a server-fed bank list.
        ...(setting ? { pin_action: "create", pin_note: CHOOSE_A_PIN } : {}),
        // **Said, loudly, before the PIN.** Only when the account this transfer
        // is resolved from was saved under a different name than the one its own
        // bank reports now.
        ...(changedName(proposed) ? { name_changed: changedName(proposed) } : {}),
        ...(error ? { error_message: error } : {}),
      },
      terminal: false,
    };
  }

  /**
   * The fee line, from **the Bank's own tariff and nothing else**.
   *
   * Read fresh on every Confirmation screen rather than copied onto the Mandate
   * when it was proposed. A proposal lives three hours, and a fee an
   * Administrator changed in between should be the one the Customer is looking
   * at when they enter their PIN — the alternative is a screen quoting a figure
   * the Bank has withdrawn.
   *
   * Which route it is comes from the **stored bank code**, the same comparison
   * that decides which endpoint moves the money. Working it out from anything
   * else would be a second answer to a question that already has one, and the
   * two would eventually disagree about a transfer that had already been priced.
   *
   * Nothing here can fail into a number. `chargeFor` answers `undefined` for a
   * Bank that has entered no tariff and for an amount its bands do not reach,
   * and both come out as the honest sentence.
   */
  private async feeNote(proposed: ProposedTransfer): Promise<string> {
    const tariff = await this.settings.tariff();

    return feeInWords(
      chargeFor(tariff, {
        intraBank: isIntraBank(proposed.destinationBankCode, this.config.bankOne.bankCode),
        amount: proposed.amount,
      }),
    );
  }

  /**
   * The screen for a proposal that can no longer be authorised, or nothing.
   *
   * Two ways to be past it — already authorised, and older than three hours —
   * and both are terminal. Checked **before** the PIN, so a transfer that could
   * never go through does not spend one of the Customer's three attempts.
   */
  /**
   * Refuses a proposal whose conversation no longer reaches the account.
   *
   * **A Mandate must not outlive the Binding that authorised it.** A proposal
   * lives for three hours and a Customer who reports a stolen handset has their
   * Binding revoked in the middle of one — so without this, the window the
   * revocation exists to close stays open on the one path that moves money.
   * Re-asked here rather than trusted from when the proposal was written, which
   * is the same rule every read already follows.
   *
   * It costs a legitimate Customer nothing: their Binding is still live, and the
   * only proposals this refuses are ones whose account the conversation is no
   * longer entitled to touch.
   */
  private async stillReaches(proposed: ProposedTransfer): Promise<TransferScreen | undefined> {
    const account = await this.conversations.accountFor(proposed.conversationId);
    if (account === proposed.sourceAccount) return undefined;

    return this.refuse(proposed, "this conversation no longer reaches that account", TRANSFER_WORDS.expired);
  }

  private async spent(proposed: ProposedTransfer): Promise<TransferScreen | undefined> {
    if (proposed.authorisedAt) {
      return this.refuse(proposed, "already authorised", TRANSFER_WORDS.alreadyAuthorised);
    }

    if (this.tooOld(proposed.createdAt)) {
      return this.refuse(proposed, "expired", TRANSFER_WORDS.expired);
    }

    return undefined;
  }

  /** The one lifetime, shared by a walk and by the proposal it becomes. */
  private tooOld(startedAt: Date): boolean {
    return this.clock.now().getTime() - startedAt.getTime() > MANDATE_LIFETIME_MS;
  }

  private async refuse(
    proposed: ProposedTransfer,
    reason: string,
    message: string,
  ): Promise<TransferScreen> {
    this.logger.warn({ event: "transfer_refused", reference: proposed.reference, reason });
    await this.audit.record({
      action: "transfer.refused",
      actor: { kind: "customer" },
      outcome: "refused",
      accountNumber: proposed.sourceAccount,
      conversationId: proposed.conversationId,
      detail: { mandateId: proposed.id, reference: proposed.reference, reason },
    });

    return unavailableScreen(message);
  }

  /**
   * Says it on the screen and in the conversation.
   *
   * The screen is what the Customer is looking at; the message is what is still
   * there when they close the Flow, on the Channel they were already on. Neither
   * is allowed to say more than the platform knows.
   */
  private async tell(mandate: Mandate, message: string): Promise<TransferScreen> {
    const conversation = await this.conversations.findById(mandate.conversationId);

    // **The notice exists because a Flow closes and a conversation does not.**
    // In the Widget the sealed surface *is* the conversation — the last screen
    // is rendered into the panel the Customer was already typing in. Sending
    // one anyway would address a WhatsApp message to an in-app handle that
    // names no correspondent at all.
    //
    // The cost is real and is recorded rather than hidden: a WhatsApp Customer
    // whose handset dies after the PIN still finds the outcome waiting, and an
    // in-app Customer whose WebView is dismissed does not. That is the same gap
    // as in-app chat having no transcript at all — the Widget keeps none, so a
    // reload loses the whole conversation and not merely this sentence — and it
    // closes when this Channel gets one rather than by inventing a second
    // delivery path for one line of it.
    if (conversation?.channel === "whatsapp") {
      await this.notifications.transferOutcome(
        conversation.channelIdentity,
        mandate.sourceAccount,
        message,
      );
    }

    return { screen: "DONE", data: { message }, terminal: true };
  }

  /**
   * Whose sealed surface a token names: the conversation, and its Channel.
   *
   * **A security control, and the two doors are the reason it exists.** A
   * WhatsApp transfer is authorised inside a payload Meta signed and encrypted;
   * the Widget's endpoint is plain HTTPS on the open internet. Each door asks
   * this and drives only its own Channel's surfaces, so a token minted on one
   * cannot be authorised through the other — in either direction, because the
   * argument is symmetric and a door that trusted the asymmetry would be
   * trusting Meta's app secret to stay secret forever.
   *
   * A token naming nothing answers `undefined`, and a caller treats that
   * exactly as it treats the wrong Channel — expired, forged, finished and
   * belonging-somewhere-else are one answer, because a handset that could tell
   * them apart would have an oracle for the price of a guessed token.
   */
  public async surfaceOwner(token: string | undefined): Promise<SurfaceOwner | undefined> {
    const walk = await this.walks.findByToken(token);
    const conversationId =
      walk?.conversationId ?? (await this.mandates.findByToken(token))?.conversationId;
    if (!conversationId) return undefined;

    const conversation = await this.conversations.findById(conversationId);
    return conversation ? { conversationId, channel: conversation.channel } : undefined;
  }
}

/** The conversation a sealed surface belongs to, and the Channel it is on. */
export interface SurfaceOwner {
  readonly conversationId: string;
  readonly channel: Channel;
}

/**
 * Both names, or nothing — the sentence a Customer reads when an account has
 * been renamed since they saved it.
 *
 * Compared on the same normalisation resolution uses, so a bank that started
 * shouting a name it used to spell in title case is not an alarm.
 */
const changedName = (proposed: ProposedTransfer): string | undefined => {
  if (!proposed.savedName) return undefined;
  if (normaliseName(proposed.savedName) === normaliseName(proposed.destinationName)) {
    return undefined;
  }

  return TRANSFER_WORDS.nameChanged(proposed.destinationName, proposed.savedName);
};

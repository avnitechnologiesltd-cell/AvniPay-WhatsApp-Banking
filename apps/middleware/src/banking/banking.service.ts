import { Inject, Injectable, Logger } from "@nestjs/common";

import type { BankingIntent, IntentOutcome, ListTransactionsIntent, TransactionRow } from "@avni/intent";
import { CLOCK, type Clock } from "@avni/service";

import type { AuditOutcome } from "../audit/actions";
import type { FailedRead } from "../bankone/adapter";
import type { AccountTransaction } from "../bankone/transactions";

import { AuditRepository } from "../audit/audit.repository";
import { BankOneAdapter } from "../bankone/adapter";
import { reasonForFailedRead } from "../bankone/outcomes";
import { ConversationsService } from "../identity/conversations.service";
import { TransfersService } from "../transfers/transfers.service";
import { BANKONE_ADAPTER } from "../tokens";
import { windowFor } from "./period";

/**
 * The **Banking Layer**. Everything that reads or moves money, and **no AI of
 * any kind** ([ADR-0001](../../../../docs/adr/0001-no-ai-in-the-banking-layer.md)).
 *
 * Every instruction arriving here is already structured. What it is *not* is
 * already resolved: the Intent names no account, and this service reads the
 * account from the conversation's Binding. That is the whole reason the Agent
 * can get *what* wrong and never *who*.
 */
@Injectable()
export class BankingService {
  private readonly logger = new Logger(BankingService.name);

  public constructor(
    @Inject(ConversationsService) private readonly conversations: ConversationsService,
    @Inject(BANKONE_ADAPTER) private readonly bankOne: BankOneAdapter,
    @Inject(TransfersService) private readonly transfers: TransfersService,
    @Inject(AuditRepository) private readonly audit: AuditRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * @param intent A **banking** Intent. Unlinking and resetting a PIN are not
   * banking — they change who reaches an account rather than what happens to the
   * money in it — and the type is what keeps them out of here rather than a
   * branch that would have to be remembered.
   */
  public async execute(conversationId: string, intent: BankingIntent): Promise<IntentOutcome> {
    const accountNumber = await this.conversations.accountFor(conversationId);
    if (!accountNumber) {
      // Recorded, because a request that could not be identified is exactly
      // what an investigation into probing wants to see.
      await this.audit.record({
        action: "intent.submitted",
        actor: { kind: "platform" },
        outcome: "refused",
        conversationId,
        detail: { kind: intent.kind, reason: "no live Binding" },
      });
      return { kind: "not_identified" };
    }

    switch (intent.kind) {
      case "check_balance":
        return this.checkBalance(conversationId, accountNumber);

      case "list_transactions":
        return this.listTransactions(conversationId, accountNumber, intent);

      case "transfer_to_account":
        // Nothing moves here. What comes back is a **Mandate waiting for a
        // Transaction PIN** — the Confirmation screen and the PIN both live
        // inside the sealed surface, and this layer's part is over once the
        // recipient is resolved.
        return this.transfers.begin(conversationId, accountNumber, intent);

      case "transfer_to_beneficiary":
        // Turning "Musa" into an account number, which is the one step where a
        // Customer's words become somebody's account by inference. Nothing here
        // moves money either: what a match decides is what the Customer is
        // *offered*, and every answer ends at the same Confirmation screen.
        return this.transfers.beginByBeneficiary(conversationId, accountNumber, intent);

      case "forget_beneficiary":
        // Moves no money and reaches BankOne not at all — there is nothing there
        // to reach, because BankOne has no Beneficiary concept. It is here
        // because the store that decides where a transfer is *offered* to go
        // sits behind the same boundary the transfer does.
        return this.transfers.beginForget(conversationId, accountNumber, intent);
    }
  }

  /**
   * A read takes no Transaction PIN and builds no **Mandate**. Reading a number
   * you already own is not ceremony.
   */
  private async checkBalance(
    conversationId: string,
    accountNumber: string,
  ): Promise<IntentOutcome> {
    const result = await this.bankOne.readBalance(accountNumber);

    // Every read is recorded, whatever it answered. Reading a Customer's money
    // is the sensitive act here — nothing changes — and it cannot be audited
    // retroactively.
    const record = (outcome: AuditOutcome, detail?: Record<string, unknown>): Promise<void> =>
      this.audit.record({
        action: "banking.balance_read",
        actor: { kind: "customer" },
        outcome,
        accountNumber,
        conversationId,
        ...(detail ? { detail } : {}),
      });

    if (result.outcome !== "ok") {
      return this.answerFailedRead(result, conversationId, record, "bankone_read_failed");
    }

    // The balance itself is not recorded. The audit table answers *who looked*,
    // and a row carrying the figure would turn every investigation into a
    // second copy of the Customer's finances.
    await record("succeeded");
    return {
      kind: "balance",
      availableBalance: result.value.availableBalance,
      ledgerBalance: result.value.ledgerBalance,
      withdrawableBalance: result.value.withdrawableBalance,
    };
  }

  /**
   * Every way a read ends that is not `ok`, answered identically for all of
   * them.
   *
   * One copy rather than one per read. What a Customer is told when BankOne
   * declines has nothing to do with **what** they asked for, and three
   * near-identical `switch`es would be three chances for the next one to
   * disagree with the others about whether an unentitled operation is a
   * failure.
   */
  private async answerFailedRead(
    result: FailedRead,
    conversationId: string,
    record: (outcome: AuditOutcome, detail?: Record<string, unknown>) => Promise<void>,
    failureEvent: string,
  ): Promise<IntentOutcome> {
    switch (result.outcome) {
      case "unavailable":
        // An entitlement the Bank has not granted is not an error to retry, and
        // nobody should be paged for one nobody has asked for yet.
        this.logger.warn({ event: "bankone_unavailable", conversationId, reason: result.reason });
        await record("unavailable", { reason: result.reason });
        return { kind: "not_available" };

      case "not_found":
        // A live Binding to an account BankOne does not hold. Worth an
        // operator's attention; the Customer is told no more than "failed".
        //
        // The *sentence* is shared with the Customers surface and the *alarm* is
        // not, and that is the split: an account BankOne does not hold is a
        // Support Officer mistyping a digit there and a broken Binding here.
        this.logger.error({ event: "bound_account_not_found", conversationId });
        await record("failed", { reason: reasonForFailedRead(result) });
        return { kind: "failed" };

      case "failed":
        // BankOne's own words go to the log and the audit table, and never to
        // the Platform, which is the layer a Customer's text is read by.
        this.logger.error({ event: failureEvent, conversationId, reason: result.reason });
        await record("failed", { reason: result.reason });
        return { kind: "failed" };
    }
  }

  /**
   * What has happened on the account recently.
   *
   * The second read, and the honest one. `GetTransactions` is **not entitled on
   * The first deployment's token** and `GetDailyAccountStatement` 404s on their
   * deployment, so today this path reaches BankOne, is told
   * *"AuthToken Not Configured for this institution"*, and answers
   * `not_available` — a first-class outcome rather than an error or an empty
   * list, because *"I cannot get that"* and *"nothing happened"* are different
   * things to tell somebody about their money (Appendix A.1; ticket 16).
   *
   * The code above and below that is written for the day the entitlement
   * arrives, and is exercised against a fake that has it.
   */
  private async listTransactions(
    conversationId: string,
    accountNumber: string,
    intent: ListTransactionsIntent,
  ): Promise<IntentOutcome> {
    const window = windowFor(intent.period, this.clock.now());
    const result = await this.bankOne.readTransactions(accountNumber, window);

    const record = (outcome: AuditOutcome, detail?: Record<string, unknown>): Promise<void> =>
      this.audit.record({
        action: "banking.transactions_read",
        actor: { kind: "customer" },
        outcome,
        accountNumber,
        conversationId,
        detail: { period: intent.period, ...detail },
      });

    if (result.outcome !== "ok") {
      // `failed` here includes a row the Middleware refused to read: a shape we
      // have never seen answering differently than we guessed, which belongs in
      // front of an operator rather than half-shown to a Customer.
      return this.answerFailedRead(
        result,
        conversationId,
        record,
        "bankone_transactions_failed",
      );
    }

    const rows = result.value.slice(0, MOST_RECENT_ROWS);
    // The count, and never the rows. The audit table answers *who looked*; a
    // row carrying the narrations and figures would turn every investigation
    // into a second copy of the Customer's finances.
    await record("succeeded", { rows: rows.length });
    return { kind: "transactions", period: intent.period, rows: rows.map(asRow) };
  }
}

/**
 * How many rows the Middleware will hand over, newest first.
 *
 * A cap rather than the lot, and it lives here rather than in the Platform
 * because this is the side of the boundary that can be trusted with the
 * decision: everything crossing it lands in the layer a Customer's text is read
 * by, and a Customer's entire financial history is not something to walk
 * through there for the sake of a message nobody would read to the end of.
 */
const MOST_RECENT_ROWS = 10;

/** BankOne's row, narrowed to what a reply needs. The reference stays here. */
const asRow = (transaction: AccountTransaction): TransactionRow => ({
  amount: transaction.amount,
  direction: transaction.direction,
  occurredAt: transaction.occurredAt?.toISOString(),
  narration: transaction.narration,
});

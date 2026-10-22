import { Inject, Injectable, Logger } from "@nestjs/common";

import type { MiddlewareConfig } from "@avni/config";
import type { TransactionPeriod } from "@avni/intent";
import { CLOCK, type Clock } from "@avni/service";

import type { Actor, AuditOutcome } from "../audit/actions";
import { AuditRepository } from "../audit/audit.repository";
import { windowFor } from "../banking/period";
import { BankOneAdapter, type FailedRead, type NameEnquiryOutcome } from "../bankone/adapter";
import { auditOutcomeOf, reasonForFailedRead } from "../bankone/outcomes";
import { BeneficiariesRepository, type Beneficiary } from "../beneficiaries/beneficiaries.repository";
import { BindingsRepository, type Binding } from "../identity/bindings.repository";
import { BANKONE_ADAPTER, MIDDLEWARE_CONFIG } from "../tokens";
import { maskChannelIdentity } from "./masking";
import { readCustomerQuery } from "./query";

/**
 * The **Customers surface** — where banking administration and support meet,
 * and the highest-privacy read in the product.
 *
 * A Support Officer looks a Customer up and sees their account, their balances,
 * their transaction history, who they pay and which handset reaches them: enough
 * to answer *"where did my money go"* without alt-tabbing into BankOne. It is
 * **predominantly read**, and not by choice — BankOne exposes no card freeze, no
 * dispute handling and no limit changes to the first deployment's tenancy (ticket 14), so
 * the writes charting imagined do not exist to build against. The one write here
 * is revoking a **Binding**, which is a security event rather than an edit.
 *
 * **Reading is the sensitive act**, which is the unusual part and the thing this
 * file is shaped by. Nothing on the surface changes anything, and nothing on it
 * can be audited retroactively — so the caller records who looked *before* the
 * look happens, and this service records what BankOne said afterwards. Two rows,
 * two questions, and the second cannot answer the first: a look that BankOne was
 * never asked about leaves no `banking.*` row at all.
 *
 * What this service is **not** is a second core-banking console. It reads what
 * BankOne holds and it reads what the Middleware holds, and it writes back to
 * neither except to destroy a Binding.
 */

/** One handset's link to this account, as an Officer is shown it. */
export interface BindingView {
  readonly id: string;
  /**
   * `••• ••• 5678`. Never the whole number — see `masking.ts` for why the
   * account-number search is what decides that.
   */
  readonly maskedIdentity: string;
  readonly enrolledAt: string;
  readonly renewedAt: string | null;
  readonly revokedAt: string | null;
  /** When the Customer last spoke to us of their own accord. */
  readonly lastActivityAt: string;
  /** A live Binding reaches the account. A revoked one is history. */
  readonly live: boolean;
}

/** What BankOne holds for the account, or the honest reason it did not say. */
export type Balances =
  | {
      readonly outcome: "read";
      /** Naira, as numbers. **No BankOne string ever leaves this module.** */
      readonly available: number;
      readonly ledger: number;
      readonly withdrawable: number;
    }
  /** An entitlement the Bank has not switched on. Not an error to retry. */
  | { readonly outcome: "not_available" }
  | { readonly outcome: "not_found" }
  | { readonly outcome: "failed" };

export interface AccountView {
  readonly accountNumber: string;
  readonly accountType: string | undefined;
  readonly balances: Balances;
}

export interface CustomerView {
  readonly accountNumber: string;
  /** The bank's own name for the account, now. Absent where BankOne would not say. */
  readonly name: string | undefined;
  /**
   * **One, today, and the shape says so rather than the prose alone.**
   *
   * BankOne offers no way to ask *which accounts does this person hold* — every
   * operation in its reference takes an account number and none takes a customer
   * identifier, and the Bank's identity API is explicitly not asked for one
   * either ([`bank-identity-api.md`](../../../../docs/reference/bank-identity-api.md) §1).
   * A **Binding** reaches one account and no other even where the same Customer
   * holds several, so the platform genuinely cannot enumerate the rest.
   *
   * Deriving them from the channel identity was considered and rejected: a
   * Nigerian number that has been recycled reaches two *different people* over
   * time, and putting a stranger's account on this screen is the one mistake a
   * privacy surface must not make.
   */
  readonly accounts: readonly AccountView[];
  /** Live first, then revoked. Both, because the revoked ones are half the story. */
  readonly bindings: readonly BindingView[];
}

/** One account a search turned up, and why. */
export interface CustomerMatch {
  readonly accountNumber: string;
  readonly name: string | undefined;
  readonly matchedOn: "account_number" | "channel_identity";
  readonly bindings: readonly BindingView[];
}

export type CustomerSearchResult =
  /** What was typed is neither an account number nor a Nigerian mobile number. */
  | { readonly outcome: "unreadable" }
  | {
      readonly outcome: "searched";
      readonly matches: readonly CustomerMatch[];
      /**
       * BankOne could not be asked about the account number that was typed.
       *
       * Separate from an empty list, because *"no such Customer"* and *"the
       * Bank did not answer"* would otherwise be the same blank screen — and an
       * Officer who concludes the first from the second tells a Customer their
       * account does not exist.
       */
      readonly bankSilent: boolean;
    };

/** One row of history, in the platform's terms rather than BankOne's. */
export interface TransactionView {
  /** Naira, positive. Which way it went is `direction`. */
  readonly amount: number;
  readonly direction: "credit" | "debit";
  /** Absent where BankOne sent a date the Middleware will not guess at. */
  readonly occurredAt: string | undefined;
  readonly narration: string | undefined;
  readonly reference: string | undefined;
}

export type CustomerTransactions =
  | {
      readonly outcome: "read";
      readonly period: TransactionPeriod;
      readonly rows: readonly TransactionView[];
    }
  /**
   * **The honest state, and today's.** `GetTransactions` is not entitled on
   * The first deployment's token, so this is what the surface answers until ticket 16
   * lands. It is a first-class outcome rather than an error or an empty list,
   * because *"I cannot look"* and *"nothing happened"* are different things to
   * tell somebody about a Customer's money.
   */
  | { readonly outcome: "not_available" }
  | { readonly outcome: "not_found" }
  | { readonly outcome: "failed" };

/** A Customer's saved recipient, read-only. */
export interface BeneficiaryView {
  readonly id: string;
  /** The Customer's own word, or empty. **Never proof of who holds the account.** */
  readonly label: string;
  /** The bank's own name for the account on the day it was saved. */
  readonly nameAtSave: string;
  readonly bankName: string;
  readonly bankCode: string;
  readonly accountNumber: string;
  readonly createdAt: string;
  readonly lastUsedAt: string;
}

export type RevokeBindingOutcome =
  | { readonly outcome: "revoked" }
  /** The Binding exists and belongs to another account. Never revealed as such. */
  | { readonly outcome: "not_found" }
  | { readonly outcome: "already_revoked" };

/**
 * How many accounts one search will resolve names for.
 *
 * A search by phone number turns up one account per Binding that number has ever
 * had, and each costs a name enquiry. Nobody has more than a handful, so the cap
 * is a runaway guard rather than paging — and if it ever bites, the Officer is
 * **told** rather than shown a quietly shortened list.
 */
const MOST_MATCHES = 10;

@Injectable()
export class CustomersService {
  private readonly logger = new Logger(CustomersService.name);

  public constructor(
    @Inject(BANKONE_ADAPTER) private readonly bankOne: BankOneAdapter,
    @Inject(BindingsRepository) private readonly bindings: BindingsRepository,
    @Inject(BeneficiariesRepository) private readonly beneficiaries: BeneficiariesRepository,
    @Inject(AuditRepository) private readonly audit: AuditRepository,
    @Inject(MIDDLEWARE_CONFIG) private readonly config: MiddlewareConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * An Officer looks somebody up.
   *
   * Both readings of what they typed are run when both are possible — see
   * `query.ts`. Results are keyed on the account, because the account is what
   * every screen below this one takes.
   */
  public async search(typed: string, actor: Actor): Promise<CustomerSearchResult> {
    const query = readCustomerQuery(typed);
    if (!query.accountNumber && !query.channelIdentity) return { outcome: "unreadable" };

    const found = new Map<string, CustomerMatch["matchedOn"]>();
    /** Names already paid for. One enquiry per account per search, never two. */
    const named = new Map<string, string | undefined>();
    let bankSilent = false;

    if (query.channelIdentity) {
      for (const binding of await this.bindings.findAllByChannelIdentity(query.channelIdentity)) {
        found.set(binding.accountNumber, "channel_identity");
      }
    }

    if (query.accountNumber && !found.has(query.accountNumber)) {
      // The only way to ask *does this account exist* — and the answer arrives
      // with the holder's name attached, which is what the Officer wants
      // anyway. An account nobody holds is simply not a match.
      const enquiry = await this.enquire(query.accountNumber, actor);
      if (enquiry.outcome === "resolved") {
        found.set(query.accountNumber, "account_number");
        named.set(query.accountNumber, enquiry.value.name);
      } else if (enquiry.outcome !== "unresolved") {
        bankSilent = true;
      }
    }

    const accounts = [...found.keys()].slice(0, MOST_MATCHES);
    if (found.size > accounts.length) {
      this.logger.warn({
        event: "customer_search_truncated",
        found: found.size,
        shown: accounts.length,
      });
    }

    return {
      outcome: "searched",
      bankSilent,
      matches: await Promise.all(
        accounts.map(async (accountNumber) => ({
          accountNumber,
          matchedOn: found.get(accountNumber) ?? "account_number",
          name: named.has(accountNumber)
            ? named.get(accountNumber)
            : await this.nameOf(accountNumber, actor),
          bindings: viewBindings(await this.bindings.findAllForAccount(accountNumber)),
        })),
      ),
    };
  }

  /** One Customer: the account, its balances, and every Binding it has had. */
  public async view(accountNumber: string, actor: Actor): Promise<CustomerView> {
    const [name, balance, bindings] = await Promise.all([
      this.nameOf(accountNumber, actor),
      this.bankOne.readBalance(accountNumber),
      this.bindings.findAllForAccount(accountNumber),
    ]);

    // Every read of a Customer's money is recorded, whoever performed it and
    // whatever it answered — the same row an enquiry over WhatsApp writes, so
    // that *"who has read this account's balance"* is one query rather than
    // one per surface. The figures are **not** in the row: the table answers
    // who looked, and carrying the balance would make every investigation a
    // second copy of the Customer's finances.
    await this.audit.record({
      action: "banking.balance_read",
      actor,
      outcome: auditOutcomeOf(balance.outcome),
      accountNumber,
      ...(balance.outcome === "ok" ? {} : { detail: { reason: reasonForFailedRead(balance) } }),
    });

    return {
      accountNumber,
      name,
      accounts: [
        {
          accountNumber,
          accountType: balance.outcome === "ok" ? balance.value.accountType : undefined,
          balances:
            balance.outcome === "ok"
              ? {
                  outcome: "read",
                  // Numbers, parsed by the adapter under the separator-stripping
                  // rule. `"1,000,000.00"` through `parseFloat` is `1`, and it
                  // fails only above ₦1,000 — so no BankOne string reaches a
                  // screen from here, ever.
                  available: balance.value.availableBalance,
                  ledger: balance.value.ledgerBalance,
                  withdrawable: balance.value.withdrawableBalance,
                }
              : { outcome: notOkOutcome(balance) },
        },
      ],
      bindings: viewBindings(bindings),
    };
  }

  /**
   * What has happened on the account, over the period the Officer chose.
   *
   * **No cap.** The WhatsApp path hands over ten rows because everything
   * crossing that boundary lands in the layer a Customer's text is read by; this
   * one crosses no such boundary, and an Officer answering *"where did my money
   * go"* with a truncated list is an Officer giving worse answers slowly. What
   * bounds the answer is the period, which BankOne is asked for and the
   * Middleware then filters again.
   */
  public async transactions(
    accountNumber: string,
    period: TransactionPeriod,
    actor: Actor,
  ): Promise<CustomerTransactions> {
    const result = await this.bankOne.readTransactions(
      accountNumber,
      windowFor(period, this.clock.now()),
    );

    await this.audit.record({
      action: "banking.transactions_read",
      actor,
      outcome: auditOutcomeOf(result.outcome),
      accountNumber,
      detail: {
        period,
        // The count, never the rows. Narrations and figures in the audit table
        // would make it a second copy of the Customer's finances.
        ...(result.outcome === "ok" ? { rows: result.value.length } : { reason: reasonForFailedRead(result) }),
      },
    });

    if (result.outcome !== "ok") return { outcome: notOkOutcome(result) };

    return {
      outcome: "read",
      period,
      rows: result.value.map((row) => ({
        amount: row.amount,
        direction: row.direction,
        occurredAt: row.occurredAt?.toISOString(),
        narration: row.narration,
        reference: row.reference,
      })),
    };
  }

  /**
   * Who this Customer pays.
   *
   * The most exposing read on the surface and the one that makes *"I sent money
   * to the wrong Musa"* answerable. It is **read-only here and nowhere else**:
   * the store is written only by a PIN-authorised transfer, and the Support
   * Agent — the AI — never reads it at all ([ADR-0008](../../../../docs/adr/0008-an-intent-becomes-a-mandate-when-authorised.md)).
   */
  public async beneficiariesOf(accountNumber: string): Promise<readonly BeneficiaryView[]> {
    return (await this.beneficiaries.findAllFor(accountNumber)).map(viewBeneficiary);
  }

  /**
   * The one write, and it is a security event rather than an edit.
   *
   * **The account is in the signature beside the Binding's id**, the way every
   * method on the Beneficiary store takes the owner beside the record. It is
   * what makes the URL an Officer clicked and the row the audit table records
   * the same Customer — without it, a Binding id from one screen could be
   * destroyed while the row said another account entirely.
   *
   * A Binding belonging to somebody else answers `not_found`, identically to one
   * that never existed. An Officer who has mistyped an account number learns
   * nothing about whose Binding they nearly reached.
   */
  public async revokeBinding(
    accountNumber: string,
    bindingId: string,
    actor: Actor,
  ): Promise<RevokeBindingOutcome> {
    /**
     * **Every attempt leaves a row, including the ones that revoke nothing.**
     *
     * The success is written by `BindingsRepository` as `binding.revoked`, so
     * these are the two ways in which it never gets there. Without them a
     * Dashboard session could walk Binding ids against an account, be refused
     * every time, and leave no trace at all — which is exactly the shape of
     * probing this table exists to make visible. Both are `refused` rather than
     * `failed`: nothing broke, and nothing happened.
     */
    const refuse = async (
      outcome: "not_found" | "already_revoked",
      reason: string,
    ): Promise<RevokeBindingOutcome> => {
      await this.audit.record({
        action: "binding.revoked",
        actor,
        outcome: "refused",
        accountNumber,
        detail: { bindingId, reason },
      });
      return { outcome };
    };

    const binding = await this.bindings.findById(bindingId);
    if (!binding || binding.accountNumber !== accountNumber) {
      return refuse("not_found", "no such Binding on this account");
    }
    if (binding.revokedAt) return refuse("already_revoked", "this Binding was already revoked");

    const revoked = await this.bindings.revoke(
      binding.id,
      actor,
      "revoked by a member of the Bank's staff from the Dashboard",
    );
    // A race with a Customer enrolling elsewhere, which revokes it first. The
    // Binding is gone either way, and the repository has written the row that
    // says who really ended it — so this one only says that we arrived late.
    return revoked
      ? { outcome: "revoked" }
      : refuse("already_revoked", "this Binding was revoked elsewhere first");
  }

  /**
   * The bank's own name for an account, and the row that records the enquiry.
   *
   * Run under **this Bank's** NIBSS code, because a Customer of this Bank is the
   * only kind this surface has. The enquiry is recorded like every other, and
   * `undefined` is returned for every way it does not resolve — an Officer is
   * shown an account with no name rather than a name this code guessed at.
   */
  private async nameOf(accountNumber: string, actor: Actor): Promise<string | undefined> {
    const enquiry = await this.enquire(accountNumber, actor);
    return enquiry.outcome === "resolved" ? enquiry.value.name : undefined;
  }

  private async enquire(accountNumber: string, actor: Actor): Promise<NameEnquiryOutcome> {
    const enquiry = await this.bankOne.nameEnquiry(accountNumber, this.config.bankOne.bankCode);

    await this.audit.record({
      action: "banking.name_enquiry",
      actor,
      outcome: ENQUIRY_OUTCOMES[enquiry.outcome],
      accountNumber,
      detail: {
        subject: "customer",
        bankCode: this.config.bankOne.bankCode,
        ...(enquiry.outcome === "resolved" ? {} : { reason: enquiry.reason }),
      },
    });

    return enquiry;
  }
}

/**
 * How a name enquiry ends, in the audit table's four words.
 *
 * `unresolved` is **`succeeded`**, and deliberately: an account number nobody
 * holds is the ordinary result of an Officer mistyping a digit, and a table in
 * which every typo is a refusal is a table nobody can find a real refusal in.
 */
const ENQUIRY_OUTCOMES: Record<NameEnquiryOutcome["outcome"], AuditOutcome> = {
  resolved: "succeeded",
  unresolved: "succeeded",
  unavailable: "unavailable",
  failed: "failed",
};

/**
 * BankOne's four read outcomes, in this surface's words.
 *
 * The only mapping here that is this file's own — `unavailable` is renamed to
 * `not_available` to match the outcome name the rest of the platform already
 * uses for *"the Bank's token does not carry this"*. What each outcome **means**
 * is decided once, in `bankone/outcomes.ts`, so the two callers that read money
 * cannot drift apart about it.
 */
const notOkOutcome = (result: FailedRead): "not_available" | "not_found" | "failed" =>
  result.outcome === "unavailable" ? "not_available" : result.outcome;

const viewBindings = (bindings: readonly Binding[]): readonly BindingView[] =>
  bindings.map((binding) => ({
    id: binding.id,
    maskedIdentity: maskChannelIdentity(binding.channelIdentity),
    enrolledAt: binding.enrolledAt.toISOString(),
    renewedAt: binding.renewedAt?.toISOString() ?? null,
    revokedAt: binding.revokedAt?.toISOString() ?? null,
    lastActivityAt: binding.lastActivityAt.toISOString(),
    live: binding.revokedAt === null,
  }));

const viewBeneficiary = (beneficiary: Beneficiary): BeneficiaryView => ({
  id: beneficiary.id,
  label: beneficiary.label,
  nameAtSave: beneficiary.nameAtSave,
  bankName: beneficiary.bankName,
  bankCode: beneficiary.bankCode,
  accountNumber: beneficiary.accountNumber,
  createdAt: beneficiary.createdAt.toISOString(),
  lastUsedAt: beneficiary.lastUsedAt.toISOString(),
});

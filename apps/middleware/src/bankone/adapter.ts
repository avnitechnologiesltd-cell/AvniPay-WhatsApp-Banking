import type { BankOneConfig } from "@avni/config";

import { parseBankOneAmount } from "./money";
import { declaresFailure, failureMessage, field, isSuccessfulCall, stringField } from "./reading";
import {
  readTransaction,
  transactionRowsIn,
  type AccountTransaction,
} from "./transactions";
import { readStatusResponse, readTransferResponse, type TransferResult } from "./transfers";

/**
 * The Middleware's adapter to BankOne, and the only route to it
 * ([ADR-0002](../../../../docs/adr/0002-middleware-is-the-sole-path-to-bankone.md)).
 *
 * It translates between the platform's vocabulary and BankOne's, and it owns
 * every rule about BankOne's wire format so that no caller has to know one.
 * What leaves this module is naira as numbers and outcomes as a closed union —
 * never a raw BankOne string, and never an HTTP status.
 *
 * v1 covers balance, transaction history, name enquiry, and both transfers with
 * the status query that settles either. **There is no NIBSS integration**: an
 * inter-bank transfer is a second endpoint on the same service, brokered by
 * BankOne against an entitlement on the Bank's own token.
 *
 * History is the odd one: it is **written against a shape nobody has observed**,
 * because the first deployment's token is not entitled to `GetTransactions` and
 * `GetDailyAccountStatement` 404s on their deployment, so there is no fallback
 * to read instead (Appendix A.1). It is implemented anyway, defensively, and
 * answers `unavailable` on that token until the entitlement arrives — which is
 * a different and truer thing to say than *something went wrong*.
 */

/** The balances BankOne holds for an account, in naira. */
export interface AccountBalance {
  readonly accountNumber: string;
  readonly availableBalance: number;
  readonly ledgerBalance: number;
  readonly withdrawableBalance: number;
  readonly accountType: string | undefined;
}

/**
 * Every way a read can end, as data. `unavailable` is first-class and distinct
 * from `failed`: an operation the Bank's token does not carry is not an error
 * to retry, it is an entitlement to request.
 */
export type ReadOutcome<T> =
  | { readonly outcome: "ok"; readonly value: T }
  | { readonly outcome: "not_found" }
  | { readonly outcome: "unavailable"; readonly reason: string }
  | { readonly outcome: "failed"; readonly reason: string };

/**
 * Every way a read ends that is not `ok`.
 *
 * Named because the Banking Layer answers all of them the same way whatever was
 * being read — what a Customer is told when BankOne declines has nothing to do
 * with what they asked for.
 */
export type FailedRead = Exclude<ReadOutcome<never>, { outcome: "ok" }>;

/** The span a Customer asked about, resolved to instants by the caller. */
export interface TransactionWindow {
  readonly from: Date;
  readonly to: Date;
}

/**
 * Who holds an account, as the account's **own bank** reports it now.
 *
 * The single most important value on the Confirmation screen, and the reason a
 * Beneficiary's saved label never appears there ([ADR-0008](../../../../docs/adr/0008-an-intent-becomes-a-mandate-when-authorised.md)).
 */
export interface AccountName {
  readonly accountNumber: string;
  readonly bankCode: string;
  readonly name: string;
  /**
   * The holder's KYC tier, where the enquiry returned one.
   *
   * BankOne documents it as nullable and it often is. It exists here for one
   * reason: `InterBankTransfer` requires a `ReceiverKYC`, and the receiving bank
   * checks its own limits against it. Passing back what name enquiry said is the
   * only way that field is ever true — see `interBankTransfer` for what happens
   * when it said nothing.
   */
  readonly kyc: string | undefined;
}

/**
 * Every way name enquiry ends.
 *
 * `unresolved` is separate from `failed` because the Customer can act on it: an
 * account number that does not resolve is usually a mistyped one, and *"check
 * the number"* is a truer thing to say than *"something went wrong"*. Both carry
 * BankOne's own words, which go to the log and the audit table and no further.
 */
export type NameEnquiryOutcome =
  | { readonly outcome: "resolved"; readonly value: AccountName }
  | { readonly outcome: "unresolved"; readonly reason: string }
  | { readonly outcome: "unavailable"; readonly reason: string }
  | { readonly outcome: "failed"; readonly reason: string };

/** What the Middleware asks BankOne to do, once the Customer has authorised it. */
export interface TransferInstruction {
  readonly fromAccountNumber: string;
  readonly toAccountNumber: string;
  /** Naira. Never kobo, and never divided by 100. */
  readonly amount: number;
  /** The Middleware's own, at most 12 characters, reused for the status query. */
  readonly reference: string;
  readonly narration: string;
}

/**
 * The same instruction, plus what NIBSS needs to reach an account this Bank
 * does not hold.
 *
 * Every field is read off the **Mandate**, which the Middleware wrote for
 * itself. `toAccountName` in particular is the interbank name enquiry's answer,
 * which is what NIBSS matches and what the Customer confirmed on the screen —
 * there is no path by which a name a Customer typed reaches it.
 */
export interface InterBankInstruction extends TransferInstruction {
  /** The destination bank's NIBSS code. Never this Bank's. */
  readonly toBankCode: string;
  /** `ReceiverName`, from the interbank name enquiry. Required by BankOne. */
  readonly toAccountName: string;
  /** The recipient's KYC tier where their bank reported one. */
  readonly toKyc: string | undefined;
  /**
   * `Payer` — the sending account's name, as this Bank reports it, and the name
   * the recipient's statement will show.
   */
  readonly fromAccountName: string;
}

export interface BankOneAdapterOptions {
  readonly config: BankOneConfig;
  /** Injectable so a test can drive it; defaults to the platform's fetch. */
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

/** BankOne's own words for an operation its token does not carry. */
const UNENTITLED = "authtoken not configured";

const WEBAPI_VERSION = "2";

/**
 * `ReceiverAccountType`, which BankOne requires and name enquiry never reports.
 *
 * `"10"` — savings — is the only value the guide gives, and there is nowhere
 * else for one to come from: the enquiry that resolves the recipient's name
 * returns their BVN and KYC tier and no account type at all. So this is a
 * constant with a documented provenance rather than a lookup that looks like
 * one. The field is informational to the receiving bank, which posts to whatever
 * account actually holds the number.
 */
const RECEIVER_ACCOUNT_TYPE = "10";

/**
 * `ReceiverKYC` where name enquiry reported none.
 *
 * Tier 1 is the **lowest** tier and carries the tightest limits, so a recipient
 * whose tier is unknown is claimed to be at the tier that permits least. The
 * receiving bank checks its own account either way; the error this default
 * chooses is a transfer declined for a limit, never one let through past one.
 */
const LOWEST_KYC_TIER = "1";

export class BankOneAdapter {
  private readonly fetch: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  public constructor(private readonly options: BankOneAdapterOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  /**
   * Balance enquiry via `GetAccountByAccountNumber`, which is widely enabled
   * and confirmed live on the first deployment's token.
   *
   * A read takes no Transaction PIN and builds no Mandate — reading a number
   * you already own is not ceremony.
   */
  public async readBalance(accountNumber: string): Promise<ReadOutcome<AccountBalance>> {
    const url = new URL(
      `${trimSlash(this.options.config.webApiBaseUrl)}/api/Account/GetAccountByAccountNumber/${WEBAPI_VERSION}`,
    );
    // WebAPI authenticates by query parameter, and spells the field `authtoken`.
    url.searchParams.set("authtoken", this.options.config.apiKey);
    url.searchParams.set("accountNumber", accountNumber);
    url.searchParams.set("institutionCode", this.options.config.institutionCode);

    const answer = await this.call(url);
    if (answer.outcome !== "ok") return answer;

    const body = answer.value;
    if (!isSuccessfulCall(body)) {
      return { outcome: "failed", reason: failureMessage(body) ?? "BankOne declined the read" };
    }

    try {
      const available = parseBankOneAmount(field(body, "AvailableBalance"));
      return {
        outcome: "ok",
        value: {
          accountNumber,
          availableBalance: available,
          // Both fall back to available rather than to zero: a missing figure
          // must not read as an empty account.
          ledgerBalance: optionalAmount(field(body, "LedgerBalance")) ?? available,
          withdrawableBalance: optionalAmount(field(body, "WithdrawableBalance")) ?? available,
          accountType: stringField(body, "AccountType"),
        },
      };
    } catch (error) {
      return {
        outcome: "failed",
        reason: error instanceof Error ? error.message : "unreadable balance",
      };
    }
  }

  /**
   * Transaction history via `GetTransactions`.
   *
   * Two defences, both because the shape is unverified:
   *
   * - **The window is applied here as well as asked for.** The date-range
   *   parameter *names* are unconfirmed (Section 11), so a deployment that does
   *   not recognise `fromDate` would answer with everything it has and look
   *   like a success. A Customer who asked about today would then be shown last
   *   year, so the rows are filtered against the window they asked for.
   * - **A row that cannot be read fails the whole read.** Dropping it would
   *   hand back a list with a transaction quietly missing from it, which is the
   *   same class of error as reporting ₦1,000,000 as ₦1 and rather harder to
   *   notice.
   *
   * Like a balance, a read takes no Transaction PIN and builds no Mandate.
   */
  public async readTransactions(
    accountNumber: string,
    window: TransactionWindow,
  ): Promise<ReadOutcome<readonly AccountTransaction[]>> {
    const url = new URL(
      `${trimSlash(this.options.config.webApiBaseUrl)}/api/Account/GetTransactions/${WEBAPI_VERSION}`,
    );
    url.searchParams.set("authtoken", this.options.config.apiKey);
    url.searchParams.set("accountNumber", accountNumber);
    url.searchParams.set("institutionCode", this.options.config.institutionCode);
    // The names the guide leads with. Sent because they cost nothing if right,
    // and never relied on, because they are unconfirmed if wrong.
    url.searchParams.set("fromDate", asDay(window.from));
    url.searchParams.set("toDate", asDay(window.to));

    const answer = await this.call(url);
    if (answer.outcome !== "ok") return answer;

    const body = answer.value;

    // Checked **before** the rows, and conditionally, because the two wrong
    // readings are both live here. `{"IsSuccessful": false, "Transactions": []}`
    // is a refusal with an empty list beside it, and taking that as an answer
    // would tell a Customer nothing happened on their account. A bare array
    // carries no flag at all, and must not fail for lacking one.
    if (declaresFailure(body)) {
      return { outcome: "failed", reason: failureMessage(body) ?? "BankOne declined the read" };
    }

    const rows = transactionRowsIn(body);
    if (!rows) {
      // No list anywhere in the body. Either BankOne declined and said so, or
      // it answered in a shape this adapter has never seen — and both are
      // failures rather than an account with nothing on it.
      return {
        outcome: "failed",
        reason: failureMessage(body) ?? "BankOne returned no readable list of transactions",
      };
    }

    let read: AccountTransaction[];
    try {
      read = rows.map(readTransaction);
    } catch (error) {
      return {
        outcome: "failed",
        reason: error instanceof Error ? error.message : "unreadable transaction row",
      };
    }

    return { outcome: "ok", value: withinWindow(read, window) };
  }

  /**
   * Name enquiry via `Transfer/NameEnquiry`, on the Third Party service.
   *
   * Run before every transfer, and its answer is what the Customer checks on the
   * Confirmation screen. Success is `IsSuccessful` **and a non-empty name** —
   * BankOne returns an empty `Name` beside a truthy flag when it cannot resolve
   * an account, and a screen showing a blank recipient is a screen that confirms
   * nothing.
   *
   * `BankCode` is required: same-bank is the Bank's own NIBSS code, another bank
   * is theirs. Sending none answers `"BankCode not sent"`.
   */
  public async nameEnquiry(accountNumber: string, bankCode: string): Promise<NameEnquiryOutcome> {
    const answer = await this.post("Transfer/NameEnquiry", {
      // `Token` here, and `AuthenticationKey` on the intra-bank transfer below.
      // The same token *value* under two different *names*, on two endpoints of
      // the same service.
      Token: this.options.config.apiKey,
      AccountNumber: accountNumber,
      BankCode: bankCode,
    });

    if (answer.outcome === "unavailable") return answer;
    if (answer.outcome === "not_found") {
      return { outcome: "unresolved", reason: "BankOne does not hold this account" };
    }
    if (answer.outcome === "failed") return answer;

    const body = answer.value;
    const name = stringField(body, "Name", "AccountName", "ReceiverName")?.trim();
    if (!isSuccessfulCall(body) || !name) {
      return {
        outcome: "unresolved",
        reason: failureMessage(body) ?? "BankOne resolved no name for this account",
      };
    }

    return {
      outcome: "resolved",
      value: { accountNumber, bankCode, name, kyc: stringField(body, "KYC", "KYCLevel")?.trim() },
    };
  }

  /**
   * Intra-bank transfer via `CoreTransactions/LocalFundsTransfer`.
   *
   * **The auth field is `AuthenticationKey`, not `Token`.** Same value, and this
   * endpoint rejects the other spelling — the one gotcha on the endpoint that
   * moves money between two accounts at this Bank.
   *
   * Every field comes from the **Mandate**, which the Middleware wrote for
   * itself. Nothing here can be reached from a payload.
   */
  public async intraBankTransfer(instruction: TransferInstruction): Promise<TransferResult> {
    return this.postTransfer("CoreTransactions/LocalFundsTransfer", {
      AuthenticationKey: this.options.config.apiKey,
      // Naira. `10` is ₦10 — never kobo, and never divided by 100.
      Amount: instruction.amount,
      FromAccountNumber: instruction.fromAccountNumber,
      ToAccountNumber: instruction.toAccountNumber,
      RetrievalReference: instruction.reference,
      Narration: instruction.narration,
    });
  }

  /**
   * Inter-bank transfer via `Transfer/InterBankTransfer`, which is NIBSS Instant
   * Payment with **BankOne brokering it**.
   *
   * There is no NIBSS integration here and there is no second money path. It is
   * a different endpoint on the same service, reached because the destination
   * bank code is not the Bank's own — and the entitlement for it is a switch on
   * The first deployment's token (Appendix A.1), not a separate agreement.
   *
   * Four differences from the intra-bank endpoint, and each has cost somebody a
   * day:
   *
   * - The auth field is **`Token`**, where the intra-bank one insists on
   *   `AuthenticationKey`. Same value, and each endpoint refuses the other's
   *   spelling.
   * - The success flag is spelled **`IsSuccessFul`**, which the reader handles
   *   because it reads both spellings.
   * - **`ReceiverName` is required**, and it must come from an interbank name
   *   enquiry rather than from anything a Customer typed. It is the field NIBSS
   *   matches, and it is the name on the Confirmation screen.
   * - A **`TransactionReference`** is sent beside the `RetrievalReference`.
   *
   * Both reference fields carry the **same value**, and deliberately. BankOne's
   * status query takes both names for one transfer, so two different values
   * would be two ways to ask about one debit and one of them would be wrong; the
   * ≤12-character cap the retrieval reference lives under is satisfied by a
   * reference that fits both. One value is also what a Customer reads back over
   * the telephone to a Support Officer.
   */
  public async interBankTransfer(instruction: InterBankInstruction): Promise<TransferResult> {
    return this.postTransfer("Transfer/InterBankTransfer", {
      // `Token`, not `AuthenticationKey`.
      Token: this.options.config.apiKey,
      Amount: instruction.amount,
      PayerAccountNumber: instruction.fromAccountNumber,
      // The guide calls this "sender name / description" and does not say it is
      // checked. It is the sending account's real name anyway, resolved by name
      // enquiry, because **this is the name that lands on the recipient's
      // statement**: NIP carries it to the other bank, and a description this
      // code composed would be this platform deciding what a Customer is called
      // to somebody they are paying. The one thing no evidence supports is
      // guessing — Appendix A's `"96" "Sender account name is not valid"` is
      // read by the guide as a provisioning problem in that environment rather
      // than a rejected field, so it is not evidence either way.
      Payer: instruction.fromAccountName,
      ReceiverBankCode: instruction.toBankCode,
      ReceiverAccountNumber: instruction.toAccountNumber,
      ReceiverName: instruction.toAccountName,
      ReceiverAccountType: RECEIVER_ACCOUNT_TYPE,
      ReceiverKYC: instruction.toKyc ?? LOWEST_KYC_TIER,
      // **Left empty even when name enquiry returned them.** Both are optional,
      // and both belong to somebody who is not this Bank's Customer. A BVN is a
      // national identifier; storing and forwarding a stranger's costs them
      // something real and buys this transfer nothing.
      ReceiverBVN: "",
      ReceiverPhoneNumber: "",
      TransactionReference: instruction.reference,
      RetrievalReference: instruction.reference,
      Narration: instruction.narration,
    });
  }

  /**
   * One transfer, and the four ways it can end.
   *
   * Shared by both endpoints because the *reading* is the same whichever moved
   * the money — what differs is the body above, and the endpoints differ in
   * every field of it.
   */
  private async postTransfer(
    path: string,
    body: Readonly<Record<string, unknown>>,
  ): Promise<TransferResult> {
    const answer = await this.post(path, body);

    switch (answer.outcome) {
      case "ok":
        return readTransferResponse(answer.value);

      // BankOne declined before it processed anything: an entitlement the Bank
      // has not switched on, or a path this deployment does not serve. No money
      // moved, so this is a failure rather than a question.
      case "unavailable":
        return { outcome: "failed", reason: answer.reason };
      case "not_found":
        return { outcome: "failed", reason: "BankOne does not serve the transfer endpoint" };

      // **The one that must not read as a failure.** A timeout, a reset socket
      // or an unreadable body all mean the request may have landed and the money
      // may be gone. Answering "failed" here is how a Customer is told their
      // transfer did not go through while their balance says otherwise — and
      // answering it by retrying is the double debit. The status query decides.
      case "failed":
        return { outcome: "unknown", reason: answer.reason };
    }
  }

  /**
   * Transaction Status Query, on the **same reference** the transfer used.
   *
   * Both reference fields carry that one value: the retrieval reference is the
   * ≤12-character one BankOne caps, and reusing it verbatim is what makes a
   * later question about this transfer answerable at all.
   *
   * Everything that is not a readable answer is `unknown` rather than a failure.
   * This endpoint is asked precisely when the platform does not know what
   * happened, and an unreachable BankOne is not evidence about a Customer's
   * money — it is a reason to ask again.
   */
  public async transactionStatus(reference: string): Promise<TransferResult> {
    const answer = await this.post("CoreTransactions/TransactionStatusQuery", {
      Token: this.options.config.apiKey,
      TransactionReference: reference,
      RetrievalReference: reference,
    });

    return answer.outcome === "ok"
      ? readStatusResponse(answer.value)
      : { outcome: "unknown", reason: answer.outcome === "not_found" ? "not found" : answer.reason };
  }

  /**
   * One request, and every way BankOne answers that is not a JSON success.
   *
   * The distinction that matters: a bad token is HTTP 400 with `Invalid Token`,
   * while an operation the Bank has not enabled is **HTTP 200** carrying
   * `AuthToken Not Configured for this institution`. One is our credential to
   * fix, the other is the Bank's entitlement to request, and reading the status
   * code alone confuses them.
   */
  private async call(url: URL): Promise<ReadOutcome<unknown>> {
    return this.request(url, { method: "GET", headers: { accept: "application/json" } });
  }

  /**
   * The Third Party service, which takes a JSON body and names its auth field
   * differently per endpoint — `Token` on most of them, `AuthenticationKey` on
   * the intra-bank transfer. The field name is the caller's to spell; everything
   * else about a request is here.
   */
  private async post(
    path: string,
    body: Readonly<Record<string, unknown>>,
  ): Promise<ReadOutcome<unknown>> {
    const url = new URL(`${trimSlash(this.options.config.thirdPartyApiBaseUrl)}/${path}`);

    return this.request(url, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  private async request(url: URL, init: RequestInit): Promise<ReadOutcome<unknown>> {
    let response: Response;
    try {
      response = await this.fetch(url, {
        ...init,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      return {
        outcome: "failed",
        reason: error instanceof Error ? `BankOne unreachable: ${error.message}` : "BankOne unreachable",
      };
    }

    const text = await response.text();

    if (text.toLowerCase().includes(UNENTITLED)) {
      return { outcome: "unavailable", reason: text.trim() };
    }
    if (response.status === 404) return { outcome: "not_found" };
    if (!response.ok) return { outcome: "failed", reason: text.trim() || `HTTP ${response.status}` };

    try {
      return { outcome: "ok", value: JSON.parse(text) as unknown };
    } catch {
      // A 200 that is not JSON is BankOne saying something the guide does not
      // document. Never fall through to success.
      return { outcome: "failed", reason: text.trim() || "BankOne returned no readable body" };
    }
  }
}

const trimSlash = (value: string): string => value.replace(/\/+$/, "");

/** `2026-08-20`. Unambiguous in a way `20/08/2026` is not. */
const asDay = (when: Date): string => when.toISOString().slice(0, 10);

/**
 * The rows that belong in the window, newest first.
 *
 * **A row whose date could not be read is kept.** An unreadable date is this
 * adapter's failure rather than evidence the transaction happened somewhere
 * else in time, and dropping it would hide money movement from the person it
 * belongs to. Undated rows sort last, where they are least likely to be read as
 * the most recent thing that happened.
 */
const withinWindow = (
  rows: readonly AccountTransaction[],
  window: TransactionWindow,
): readonly AccountTransaction[] =>
  rows
    .filter(
      (row) =>
        !row.occurredAt ||
        (row.occurredAt.getTime() >= window.from.getTime() &&
          row.occurredAt.getTime() <= window.to.getTime()),
    )
    .sort((left, right) => (right.occurredAt?.getTime() ?? 0) - (left.occurredAt?.getTime() ?? 0));

const optionalAmount = (value: unknown): number | undefined => {
  if (value === undefined || value === null) return undefined;
  try {
    return parseBankOneAmount(value);
  } catch {
    return undefined;
  }
};

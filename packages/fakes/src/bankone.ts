import type { ServerResponse } from "node:http";

import { respondJson, respondText, startFake, type FakeService, type RecordedRequest } from "./server";

/**
 * BankOne, speaking the wire format Appendix A observed rather than the one
 * the guide documents. Three of its habits are load-bearing and all three are
 * reproduced here:
 *
 * - **Balances carry thousands separators** at values ≥ 1000. `"1,000,000.00"`
 *   through `parseFloat` is `1`. Every documented example misses this, and it
 *   fails only above ₦1,000, so small-value testing never catches it.
 * - **`IsSuccessful` is spelled two ways**, and casing varies by endpoint.
 * - **A bad token 400s with `Invalid Token`; an unentitled operation answers
 *   HTTP 200** with `AuthToken Not Configured for this institution`. Telling
 *   those apart is the difference between "fix the credential" and "ask the
 *   Bank for an entitlement".
 */

export interface FakeAccount {
  readonly accountNumber: string;
  /** Naira, as a number. The fake formats it the way BankOne would. */
  readonly availableBalance: number;
  readonly ledgerBalance?: number;
  readonly withdrawableBalance?: number;
  readonly accountType?: string;
  readonly accountName?: string;
  /** What `GetTransactions` answers for this account, newest first or not. */
  readonly transactions?: readonly FakeTransaction[];
}

/** One row, in the fake's own terms. The dialect decides how it is spelled. */
export interface FakeTransaction {
  /** Naira, and always positive — `direction` says which way it went. */
  readonly amount: number;
  readonly direction: "credit" | "debit";
  readonly occurredAt: Date;
  readonly narration?: string;
  readonly reference?: string;
}

/**
 * The three shapes `GetTransactions` might answer in.
 *
 * Nobody on this project has seen the real one — the first deployment's token is not
 * entitled to the endpoint and `GetDailyAccountStatement` 404s on their
 * deployment (Appendix A.1), so the specification lists field names with
 * *"e.g."* beside them. A fake that picked one spelling would let the adapter
 * bet on that spelling and call it verified.
 *
 * - **`documented`** — `{ Transactions: [...] }`, `Amount`, `RecordType`,
 *   `TransactionDate`, `Narration`, `ReferenceID`. The guide's first column.
 * - **`alternate`** — a **bare array**, `TransactionAmount`, `DrCr`,
 *   `PostingDate` as an ASP.NET `/Date(…)/`, `Description`,
 *   `TransactionReference`. The guide's second column.
 * - **`signed`** — `{ Data: [...] }`, a **negative `Amount` and no marker at
 *   all**, `ValueDate` as ambiguous `dd/MM/yyyy`, `TransactionDetails`.
 */
export type FakeTransactionDialect = "documented" | "alternate" | "signed";

/**
 * What `Transfer/NameEnquiry` resolves, per account **and bank**.
 *
 * Keyed by both, and that is the point rather than an accident of the map. Real
 * staging resolved one fabricated number to the same holder at two different
 * banks (Appendix A.4), which is a stub — so a test seeds a *different* name per
 * bank, and code that ran the enquiry under the wrong bank code shows the wrong
 * name on the Confirmation screen instead of passing by accident.
 */
export interface FakeAccountName {
  readonly accountNumber: string;
  /** The NIBSS code the enquiry was made under. */
  readonly bankCode: string;
  readonly name: string;
  /** The holder's KYC tier, which BankOne documents as nullable and often is. */
  readonly kyc?: string;
}

/** One transfer this fake was asked to perform, by either endpoint. */
export interface FakeTransferRequest {
  /** Which endpoint carried it. The whole of intra- versus inter-bank. */
  readonly endpoint: "LocalFundsTransfer" | "InterBankTransfer";
  /** `RetrievalReference`. The one BankOne caps at 12 characters. */
  readonly reference: string;
  readonly fromAccountNumber: string;
  readonly toAccountNumber: string;
  /** Naira, as it arrived. A fake that divided by 100 would hide the bug. */
  readonly amount: unknown;
  readonly narration: string;
  /** `TransactionReference`. Inter-bank only, where BankOne requires one. */
  readonly transactionReference?: string;
  /** `ReceiverBankCode`. Inter-bank only. */
  readonly bankCode?: string;
  /** `ReceiverName`, which the inter-bank endpoint refuses to do without. */
  readonly receiverName?: string;
  /** `Payer` — the sending account's name, and what the recipient will see. */
  readonly payer?: string;
}

/**
 * How a transfer and its status query behave, which is the whole surface a
 * money-movement test needs.
 *
 * `drops` is the one worth explaining: BankOne receives the transfer, performs
 * it, and the **response never arrives**. That is the shape of every real double
 * debit — a caller that reads a lost response as a failure and sends the request
 * again. The fake records the transfer before dropping the connection, so a
 * second dispatch would be visible in `transfers`.
 */
export interface FakeTransferBehaviour {
  /**
   * `invalid` is the one that is not about the money: BankOne refused the
   * *shape* of the request with response code `12`. It means the same thing to a
   * Customer as `fails` — nothing moved — and something entirely different to
   * the Bank, which is a defect of ours rather than somebody declining.
   */
  readonly dispatch: "succeeds" | "pending" | "fails" | "drops" | "invalid";
  /** How many status queries answer *not final* before the final one. */
  readonly pendingQueries?: number;
  /** What the status query settles on. `never` never settles. */
  readonly settles?: "succeeded" | "failed" | "never";
  /** BankOne's own words on a `fails` dispatch. */
  readonly failureMessage?: string;
}

export interface FakeBankOneOptions {
  readonly authToken: string;
  readonly institutionCode: string;
  readonly accounts?: readonly FakeAccount[];
  /** What name enquiry resolves. Nothing resolves that is not listed. */
  readonly names?: readonly FakeAccountName[];
  readonly transfer?: FakeTransferBehaviour;
  /**
   * Operations the Bank's token does not have. The first deployment's real answer for
   * `GetTransactions` (ticket 14, A.1) — HTTP 200 and a message, never an error
   * status.
   */
  readonly unentitled?: readonly string[];
  /** Spell the success flag the other documented way. */
  readonly successFlagSpelling?: "IsSuccessful" | "IsSuccessFul";
  /** How `GetTransactions` spells its rows. Defaults to `documented`. */
  readonly transactionDialect?: FakeTransactionDialect;
}

/**
 * Formats naira the way BankOne does: a decimal string, grouped with commas
 * above 999. This one function is the reason the fake is an HTTP server.
 */
export const formatBankOneAmount = (naira: number): string =>
  naira.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const UNENTITLED_BODY = "AuthToken Not Configured for this institution";

export interface FakeBankOne extends FakeService {
  /** Add or replace an account while the fake is running. */
  readonly setAccount: (account: FakeAccount) => void;
  /**
   * Grant or withdraw an operation mid-test.
   *
   * An entitlement is a switch the Bank throws, not a redeployment, so the fake
   * models it as one — the same Customer asking the same question can be walked
   * across the day the Bank turns `GetTransactions` on.
   */
  readonly setEntitled: (operation: string, entitled: boolean) => void;
  /** Change how rows are spelled while the fake is running. */
  readonly setTransactionDialect: (dialect: FakeTransactionDialect) => void;
  /**
   * Makes an operation answer HTTP 200 carrying `IsSuccessful: false` **and an
   * empty list beside it**.
   *
   * The nastiest shape BankOne can produce on a list endpoint, and the reason
   * it is worth reproducing: a caller that looks for rows without checking the
   * flag finds `[]` and tells a Customer nothing happened on their account.
   */
  readonly setDeclaredFailure: (operation: string, message: string) => void;

  /** Every transfer this fake received, by either endpoint, in order. */
  readonly transfers: readonly FakeTransferRequest[];
  /** Every reference a status query asked about, in order. */
  readonly statusQueries: readonly string[];
  /** What name enquiry resolves for one account at one bank. */
  readonly setName: (name: FakeAccountName) => void;
  readonly setTransferBehaviour: (behaviour: FakeTransferBehaviour) => void;
}

export const startFakeBankOne = async (
  options: FakeBankOneOptions,
): Promise<FakeBankOne> => {
  const accounts = new Map<string, FakeAccount>(
    (options.accounts ?? []).map((account) => [account.accountNumber, account]),
  );
  const names = new Map<string, FakeAccountName>(
    (options.names ?? []).map((name) => [`${name.bankCode}:${name.accountNumber}`, name]),
  );
  const unentitled = new Set(options.unentitled ?? []);
  const declaredFailures = new Map<string, string>();
  const successFlag = options.successFlagSpelling ?? "IsSuccessful";
  let dialect: FakeTransactionDialect = options.transactionDialect ?? "documented";
  let transfer: FakeTransferBehaviour = options.transfer ?? { dispatch: "succeeds" };

  const transfers: FakeTransferRequest[] = [];
  const statusQueries: string[] = [];
  /** How many times each reference has been asked about, for the pending walk. */
  const queried = new Map<string, number>();

  /**
   * How a dispatch ends, once the request has been recorded.
   *
   * Shared by both transfer endpoints because the *behaviour* a test asks for is
   * about the money rather than about which endpoint moved it. What is not
   * shared is the spelling of the success flag, which is why it is a parameter:
   * the inter-bank endpoint spells it `IsSuccessFul` whatever the rest of this
   * fake is configured to say.
   */
  const answerDispatch = (
    response: ServerResponse,
    flag: string,
    reference: string,
  ): void => {
    if (transfer.dispatch === "drops") {
      // The response never arrives. The request did, and is already recorded.
      response.destroy();
      return;
    }
    if (transfer.dispatch === "invalid") {
      respondJson(response, 200, {
        Status: 12,
        [flag]: false,
        ResponseCode: "12",
        ResponseMessage: transfer.failureMessage ?? "Invalid request",
        Reference: reference,
      });
      return;
    }
    if (transfer.dispatch === "fails") {
      respondJson(response, 200, {
        Status: "Failed",
        [flag]: false,
        ResponseCode: "96",
        ResponseMessage: transfer.failureMessage ?? "Insufficient funds",
        Reference: reference,
      });
      return;
    }
    if (transfer.dispatch === "pending") {
      respondJson(response, 200, {
        [flag]: true,
        ResponseCode: "01",
        ResponseMessage: "Transaction in progress",
        Reference: reference,
      });
      return;
    }

    respondJson(response, 200, {
      [flag]: true,
      ResponseCode: "00",
      ResponseMessage: "Approved by Financial Institution",
      Reference: reference,
    });
  };

  /**
   * The Third Party service: name enquiry, both transfers, and the status query
   * that says what became of either.
   */
  const thirdParty = (request: RecordedRequest, response: ServerResponse): void => {
    const operation = request.path.split("/").filter(Boolean).at(-1) ?? "";
    const body = (request.body ?? {}) as Record<string, unknown>;

    if (unentitled.has(operation)) {
      respondText(response, 200, UNENTITLED_BODY);
      return;
    }

    if (operation === "NameEnquiry") {
      if (body["Token"] !== options.authToken) {
        respondText(response, 400, "Invalid Token");
        return;
      }
      const bankCode = String(body["BankCode"] ?? "");
      if (!bankCode) {
        respondJson(response, 200, { [successFlag]: false, ResponseMessage: "BankCode not sent" });
        return;
      }

      const resolved = names.get(`${bankCode}:${String(body["AccountNumber"] ?? "")}`);
      if (!resolved) {
        // A truthy flag beside an **empty name**, which is the shape that makes
        // "success is the flag" the wrong reading on this endpoint.
        respondJson(response, 200, {
          [successFlag]: true,
          Name: "",
          ResponseMessage: "Account could not be resolved",
        });
        return;
      }

      respondJson(response, 200, {
        [successFlag]: true,
        Name: resolved.name,
        // Nullable in the guide and null more often than not, which is why the
        // Middleware has a defensible answer for when it is missing.
        KYC: resolved.kyc ?? null,
        BVN: null,
        ResponseMessage: "Successful",
        DefaultGateWay: "ISW",
      });
      return;
    }

    if (operation === "LocalFundsTransfer") {
      // **`AuthenticationKey`, and this endpoint refuses `Token`.** The same
      // value under a different field name, on one endpoint of the same service.
      if (body["AuthenticationKey"] !== options.authToken) {
        respondText(response, 400, "Invalid Token");
        return;
      }

      const reference = String(body["RetrievalReference"] ?? "");
      if (reference.length > 12) {
        respondJson(response, 200, {
          [successFlag]: false,
          ResponseCode: "12",
          ResponseMessage: "Invalid Retrieval Reference. Max Length 12",
        });
        return;
      }

      // Recorded **before** anything can go wrong with the response, because a
      // transfer BankOne performed and could not report is exactly the case a
      // test needs to see.
      transfers.push({
        endpoint: "LocalFundsTransfer",
        reference,
        fromAccountNumber: String(body["FromAccountNumber"] ?? ""),
        toAccountNumber: String(body["ToAccountNumber"] ?? ""),
        amount: body["Amount"],
        narration: String(body["Narration"] ?? ""),
      });

      answerDispatch(response, successFlag, reference);
      return;
    }

    /**
     * NIP, brokered by BankOne. A **different endpoint on the same service**,
     * and every difference below is one the guide records:
     *
     * - the auth field is `Token`, where `LocalFundsTransfer` insists on
     *   `AuthenticationKey`, and each refuses the other's spelling;
     * - the success flag is spelled **`IsSuccessFul`** whatever the rest of this
     *   fake is configured to say, because that is how this endpoint spells it;
     * - `ReceiverName`, `ReceiverBankCode`, `ReceiverAccountType`, `ReceiverKYC`
     *   and `TransactionReference` are all **required**, so a caller that
     *   forgot one is refused here rather than quietly passing a test.
     */
    if (operation === "InterBankTransfer") {
      if (body["Token"] !== options.authToken) {
        respondText(response, 400, "Invalid Token");
        return;
      }

      const reference = String(body["RetrievalReference"] ?? "");
      const missing = requiredInterBankField(body);
      if (missing) {
        // A validation error: numeric `Status`, response code `12`, and no money
        // anywhere near it.
        respondJson(response, 200, {
          Status: 12,
          IsSuccessFul: false,
          ResponseCode: "12",
          ResponseMessage: missing,
        });
        return;
      }
      if (reference.length > 12) {
        respondJson(response, 200, {
          Status: 12,
          IsSuccessFul: false,
          ResponseCode: "12",
          ResponseMessage: "Invalid Retrieval Reference. Max Length 12",
        });
        return;
      }

      transfers.push({
        endpoint: "InterBankTransfer",
        reference,
        fromAccountNumber: String(body["PayerAccountNumber"] ?? ""),
        toAccountNumber: String(body["ReceiverAccountNumber"] ?? ""),
        amount: body["Amount"],
        narration: String(body["Narration"] ?? ""),
        transactionReference: String(body["TransactionReference"] ?? ""),
        bankCode: String(body["ReceiverBankCode"] ?? ""),
        receiverName: String(body["ReceiverName"] ?? ""),
        payer: String(body["Payer"] ?? ""),
      });

      answerDispatch(response, "IsSuccessFul", reference);
      return;
    }

    if (operation === "TransactionStatusQuery") {
      if (body["Token"] !== options.authToken) {
        respondText(response, 400, "Invalid Token");
        return;
      }

      const reference = String(body["TransactionReference"] ?? body["RetrievalReference"] ?? "");
      statusQueries.push(reference);

      if (!transfers.some((sent) => sent.reference === reference)) {
        respondJson(response, 200, {
          [successFlag]: true,
          ResponseCode: "96",
          Status: "Failed",
          ResponseMessage: "No transaction with that reference",
        });
        return;
      }

      const asked = (queried.get(reference) ?? 0) + 1;
      queried.set(reference, asked);

      const settles = transfer.settles ?? "succeeded";
      if (settles === "never" || asked <= (transfer.pendingQueries ?? 0)) {
        respondJson(response, 200, {
          [successFlag]: true,
          ResponseCode: "01",
          Status: "Pending",
          ResponseMessage: "Transaction in progress",
        });
        return;
      }

      if (settles === "failed") {
        // **Appendix A.3, verbatim.** `IsSuccessful: true` means the *query*
        // ran; `ResponseCode "06"` is in no documented table; `Status` is the
        // only field telling the truth about the money. A reader that trusts
        // the flag here reports a failed transfer as a successful one.
        respondJson(response, 200, {
          [successFlag]: true,
          ResponseMessage: "Failed",
          ResponseCode: "06",
          Status: "Failed",
        });
        return;
      }

      respondJson(response, 200, {
        [successFlag]: true,
        ResponseCode: "00",
        Status: "Successful",
        ResponseMessage: "Approved by Financial Institution",
      });
      return;
    }

    respondText(response, 404, `No fake for ${operation}`);
  };

  const service = await startFake((request, response) => {
    // The Third Party service takes a JSON body and authenticates inside it;
    // the WebAPI takes query parameters. Two services, one token value, and the
    // auth field spelled differently on each — which is the point of a fake that
    // is an HTTP server rather than a mocked class.
    if (request.method === "POST") {
      thirdParty(request, response);
      return;
    }

    const operation = request.path.split("/").filter(Boolean).at(-2) ?? "";

    // WebAPI authenticates by query parameter, and names the field `authtoken`.
    const token = request.query["authtoken"];
    if (token !== options.authToken) {
      respondText(response, 400, "Invalid Token");
      return;
    }
    if (unentitled.has(operation)) {
      respondText(response, 200, UNENTITLED_BODY);
      return;
    }
    const declared = declaredFailures.get(operation);
    if (declared !== undefined) {
      // A refusal with an empty list beside it. Both halves are the point.
      respondJson(response, 200, {
        [successFlag]: false,
        ResponseCode: "96",
        ResponseMessage: declared,
        Transactions: [],
      });
      return;
    }

    if (operation === "GetAccountByAccountNumber") {
      if (request.query["institutionCode"] !== options.institutionCode) {
        respondText(response, 400, "Invalid Institution Code");
        return;
      }

      const account = accounts.get(request.query["accountNumber"] ?? "");
      if (!account) {
        // Not found is a plain-text 404, not a JSON error body.
        respondText(response, 404, "Account not found");
        return;
      }

      respondJson(response, 200, {
        [successFlag]: true,
        ResponseCode: "00",
        AvailableBalance: formatBankOneAmount(account.availableBalance),
        LedgerBalance: formatBankOneAmount(account.ledgerBalance ?? account.availableBalance),
        WithdrawableBalance: formatBankOneAmount(
          account.withdrawableBalance ?? account.availableBalance,
        ),
        AccountType: account.accountType ?? "Savings/Current Account",
        AccountName: account.accountName ?? "EXAMPLE CUSTOMER",
        AccountNumber: account.accountNumber,
      });
      return;
    }

    if (operation === "GetTransactions") {
      const account = accounts.get(request.query["accountNumber"] ?? "");
      if (!account) {
        respondText(response, 404, "Account not found");
        return;
      }

      // The date range in the query is **deliberately ignored**. Its parameter
      // names are unverified (Section 11), so an adapter that trusted the
      // server to honour them would be trusting a guess — and this fake exists
      // to make that guess fail out loud rather than quietly work.
      respondJson(response, 200, envelope(dialect, successFlag, account.transactions ?? []));
      return;
    }

    respondText(response, 404, `No fake for ${operation}`);
  });

  return {
    ...service,
    setAccount: (account) => accounts.set(account.accountNumber, account),
    setEntitled: (operation, entitled) => {
      if (entitled) unentitled.delete(operation);
      else unentitled.add(operation);
    },
    setTransactionDialect: (next) => {
      dialect = next;
    },
    setDeclaredFailure: (operation, message) => declaredFailures.set(operation, message),
    transfers,
    statusQueries,
    setName: (name) => names.set(`${name.bankCode}:${name.accountNumber}`, name),
    setTransferBehaviour: (next) => {
      transfer = next;
    },
  };
};

/**
 * The first `InterBankTransfer` field that is missing, in BankOne's own words.
 *
 * Every one of these is documented as required, and the fake enforces them for a
 * reason: `ReceiverName` in particular can only come from an interbank name
 * enquiry, and a Middleware that skipped that call would otherwise send a
 * perfectly well-formed transfer with a blank recipient and pass a test.
 */
const requiredInterBankField = (body: Record<string, unknown>): string | undefined => {
  const said = (field: string): string => String(body[field] ?? "").trim();

  if (!said("ReceiverBankCode")) return "Receiverbankcode not sent";
  if (!said("ReceiverAccountNumber")) return "Receiveraccountnumber not sent";
  if (!said("ReceiverName")) return "Receivername not sent";
  if (!said("ReceiverAccountType")) return "Receiveraccounttype not sent";
  if (!said("ReceiverKYC")) return "Receiverkyc not sent";
  if (!said("PayerAccountNumber")) return "Payeraccountnumber not sent";
  if (!said("Payer")) return "Payer not sent";
  if (!said("TransactionReference")) return "Transactionreference not sent";
  if (!said("RetrievalReference")) return "Retrievalreference not sent";

  return undefined;
};

// --- Rendering rows the three ways BankOne might --------------------------

const envelope = (
  dialect: FakeTransactionDialect,
  successFlag: string,
  transactions: readonly FakeTransaction[],
): unknown => {
  const rows = transactions.map((transaction) => row(dialect, transaction));

  switch (dialect) {
    case "documented":
      return { [successFlag]: true, ResponseCode: "00", Transactions: rows };
    // A bare array, with no success flag anywhere to read.
    case "alternate":
      return rows;
    case "signed":
      return { [successFlag]: true, Data: rows };
  }
};

const row = (
  dialect: FakeTransactionDialect,
  transaction: FakeTransaction,
): Readonly<Record<string, unknown>> => {
  const { amount, direction, occurredAt, narration, reference } = transaction;

  switch (dialect) {
    case "documented":
      return {
        Amount: formatBankOneAmount(amount),
        RecordType: direction === "credit" ? "C" : "D",
        TransactionDate: isoWithoutZone(occurredAt),
        Narration: narration ?? "",
        ReferenceID: reference ?? "",
      };

    case "alternate":
      return {
        TransactionAmount: formatBankOneAmount(amount),
        DrCr: direction === "credit" ? "CR" : "DR",
        PostingDate: aspNetDate(occurredAt),
        Description: narration ?? "",
        TransactionReference: reference ?? "",
      };

    case "signed":
      return {
        // No marker at all — which way it went is the sign, and nothing else.
        Amount: formatBankOneAmount(direction === "credit" ? amount : -amount),
        ValueDate: ambiguousDate(occurredAt),
        TransactionDetails: narration ?? "",
        Reference: reference ?? "",
      };
  }
};

/** `2026-08-20T14:03:11` — .NET's default, and it names no timezone. */
const isoWithoutZone = (when: Date): string => when.toISOString().replace(/\.\d+Z$/, "");

/** `/Date(1755700000000)/` — ASP.NET's JSON date, still in the wild. */
const aspNetDate = (when: Date): string => `/Date(${when.getTime()})/`;

/**
 * `20/08/2026`. Unreadable on purpose: `dd/MM` and `MM/dd` are the same nine
 * characters, and a bank that guesses which one it is has invented a date.
 */
const ambiguousDate = (when: Date): string =>
  [when.getUTCDate(), when.getUTCMonth() + 1, when.getUTCFullYear()]
    .map((part, index) => (index === 2 ? String(part) : String(part).padStart(2, "0")))
    .join("/");

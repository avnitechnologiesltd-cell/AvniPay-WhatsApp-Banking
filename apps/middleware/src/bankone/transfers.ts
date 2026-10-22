import { failureMessage, field, stringField } from "./reading";

/**
 * How BankOne answers about money that may have moved, and the two readings
 * that must never be confused.
 *
 * A **transfer** response follows the guide's general rule — `ResponseCode`
 * first, then a success flag under either spelling. A **Transaction Status
 * Query** does not: `IsSuccessful: true` there means the *query* executed, and
 * has been observed beside `Status: "Failed"` on the one endpoint whose entire
 * job is establishing whether money moved (Appendix A.3). So there are two
 * readers below, and the status one reads `ResponseCode`/`Status` **only**.
 */

/**
 * What BankOne said, as data.
 *
 * `unknown` is the variant that matters and the one a smaller union would have
 * lost. A transfer whose response never arrived is **not a failure** — the
 * request may have landed and the money may be gone — and treating it as one is
 * how a platform tells a Customer their transfer failed while their balance says
 * otherwise. It is also not something to retry: a second dispatch on a request
 * that did land is the double debit. It is a question for the status query.
 */
export type TransferResult =
  | { readonly outcome: "succeeded"; readonly reason?: string; readonly code?: string }
  /** Not final. First-class: BankOne is entitled to say "not yet". */
  | { readonly outcome: "pending"; readonly reason?: string; readonly code?: string }
  | { readonly outcome: "failed"; readonly reason: string; readonly code?: string }
  /**
   * BankOne could not be asked, or answered something unreadable. Not a "no".
   *
   * It carries **no code**, and that absence is the type saying what happened:
   * an `unknown` is a transfer BankOne never told us about, so there is nothing
   * of BankOne's to record against it.
   */
  | { readonly outcome: "unknown"; readonly reason: string };

const SUCCESS_CODE = "00";

/**
 * BankOne's code for *your request was malformed* (`bankone-api.md` §8).
 *
 * Carried out of here so the audit row can say which kind of failure this was.
 * A `96` is a business decline — the Bank, NIBSS or the receiving institution
 * said no, and the Customer's transfer did not happen for a reason about the
 * money. A `12` is the Middleware having sent something BankOne would not
 * accept, which is a defect of ours and no Customer's fault. Both mean the money
 * stayed, both are told to the Customer the same way, and the Bank must be able
 * to tell them apart afterwards.
 */
export const VALIDATION_CODE = "12";

export const isValidationFailure = (result: TransferResult): boolean =>
  result.outcome === "failed" && result.code === VALIDATION_CODE;

/**
 * The codes the guide documents as not-yet-final. Everything outside this set
 * and `"00"` is a **failure**, documented or not — `"06"` was observed in the
 * wild and appears in no table (Appendix A.3), and a reader that fell through on
 * an unrecognised code would have read that one as success.
 */
const PENDING_CODES = new Set(["01", "09", "25", "91"]);

const fromResponseCode = (code: string, message: string | undefined): TransferResult => {
  if (code === SUCCESS_CODE) {
    return message ? { outcome: "succeeded", reason: message, code } : { outcome: "succeeded", code };
  }
  if (PENDING_CODES.has(code)) {
    return { outcome: "pending", reason: message ?? `response code ${code}`, code };
  }
  return {
    outcome: "failed",
    reason: message ? `${message} (response code ${code})` : `response code ${code}`,
    code,
  };
};

/** A `LocalFundsTransfer` or `InterBankTransfer` response. */
export const readTransferResponse = (body: unknown): TransferResult => {
  const code = stringField(body, "ResponseCode");
  if (code) return fromResponseCode(code, failureMessage(body));

  // No code at all. The success flag is the guide's fallback, is spelled two
  // ways, and arrives as a JSON boolean on some endpoints and as a string on
  // others; a body carrying neither tells us nothing about the money, which is
  // `unknown` rather than either answer.
  const flag = field(body, "IsSuccessful", "IsSuccessFul");
  if (flag === true || flag === "true" || flag === "True") return { outcome: "succeeded" };
  if (flag === false || flag === "false" || flag === "False") {
    return { outcome: "failed", reason: failureMessage(body) ?? "BankOne declined the transfer" };
  }
  return { outcome: "unknown", reason: "BankOne answered a transfer in a shape this adapter cannot read" };
};

/** Words a status query uses for an outcome, where it sends no response code. */
const SETTLED = new Set(["successful", "success", "approved", "completed", "complete"]);
const NOT_FINAL = new Set(["pending", "in progress", "inprogress", "processing", "not final"]);

/**
 * A `TransactionStatusQuery` response.
 *
 * **`IsSuccessful` is not consulted here at any point.** Appendix A.3 records
 * `{"IsSuccessful": true, "ResponseCode": "06", "Status": "Failed"}` — a query
 * that ran perfectly, about a transfer that failed. The general rule is wrong
 * for this one endpoint, and this is the endpoint the answer comes from.
 */
export const readStatusResponse = (body: unknown): TransferResult => {
  const code = stringField(body, "ResponseCode");
  if (code) return fromResponseCode(code, failureMessage(body));

  const status = stringField(body, "Status", "TransactionStatus", "StatusDescription")
    ?.trim()
    .toLowerCase();

  if (status) {
    if (SETTLED.has(status)) return { outcome: "succeeded", reason: status };
    if (NOT_FINAL.has(status)) return { outcome: "pending", reason: status };
    // Anything else is a failure rather than a fall-through. An unrecognised
    // status is not evidence the money arrived.
    return { outcome: "failed", reason: failureMessage(body) ?? `status ${status}` };
  }

  // Neither a code nor a status. Silence is not failure either: the poll asks
  // again, and the bound decides when to stop asking.
  return { outcome: "unknown", reason: "BankOne answered the status query with nothing to read" };
};

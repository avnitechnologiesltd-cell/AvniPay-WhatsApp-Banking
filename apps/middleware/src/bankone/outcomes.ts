import type { AuditOutcome } from "../audit/actions";
import type { FailedRead } from "./adapter";

/**
 * How a BankOne read that did not succeed is described, in one place.
 *
 * Two callers read money — the Banking Layer, answering a Customer over a
 * Channel, and the Customers surface, answering a Support Officer at a
 * Dashboard. They answer *differently*, and should: a Customer is told one
 * sentence and a Support Officer is shown four states. What they must **not**
 * do differently is disagree about **what BankOne's silence meant**, and that is
 * the whole of what lives here.
 *
 * `banking.service.ts` states the rule this file exists to keep: *"three
 * near-identical `switch`es would be three chances for the next one to disagree
 * with the others about whether an unentitled operation is a failure."* That
 * comment was written about one service; it is truer now that there are two.
 */

/**
 * The four words the audit table has.
 *
 * **`unavailable` is not `failed`.** An entitlement the Bank has not switched on
 * is a thing to request, not an incident to page somebody about, and a table
 * that cannot tell them apart is a table in which ticket 16's outstanding
 * request looks like an outage.
 */
export const auditOutcomeOf = (outcome: "ok" | FailedRead["outcome"]): AuditOutcome => {
  switch (outcome) {
    case "ok":
      return "succeeded";
    case "unavailable":
      return "unavailable";
    case "not_found":
    case "failed":
      return "failed";
  }
};

/**
 * BankOne's own words for why, which go to the log and the audit table and
 * **never to a Customer**.
 *
 * `not_found` carries no message of its own — it is a plain-text 404 — so this
 * is the one sentence the platform supplies, and it says only what BankOne
 * asserted rather than what that might mean. What it *means* differs by caller:
 * on a Customer's own account it is a live Binding pointing at nothing and
 * belongs in front of an operator; on the Customers surface it is a Support
 * Officer mistyping a digit, which is ordinary. Both read the same string and
 * decide separately what to do about it.
 */
export const reasonForFailedRead = (result: FailedRead): string =>
  result.outcome === "not_found" ? "BankOne does not hold this account" : result.reason;

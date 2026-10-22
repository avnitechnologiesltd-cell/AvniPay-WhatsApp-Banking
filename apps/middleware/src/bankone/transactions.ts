import type { TransactionDirection } from "@avni/intent";

import { parseBankOneAmount } from "./money";
import { field, stringField } from "./reading";

/**
 * Reading `GetTransactions` rows, against a shape **nobody on this project has
 * observed**.
 *
 * The first deployment's token is not entitled to the endpoint and
 * `GetDailyAccountStatement` 404s on their deployment, so there is no fallback
 * to read instead ([`bankone-api.md`](../../../../docs/reference/bankone-api.md)
 * Appendix A.1). The specification's own field table says *"e.g. `Amount` /
 * `TransactionAmount`"* — it is describing a family of shapes rather than one.
 *
 * So this module reads a family. Every field is looked up under each documented
 * spelling, the container is found wherever BankOne put it, and anything that
 * cannot be read honestly is **refused rather than guessed** — the rule
 * `parseBankOneAmount` already holds for balances, applied to a list.
 */

/** One row, in the platform's terms rather than BankOne's. */
export interface AccountTransaction {
  /** Naira, and always positive. Which way it went is `direction`. */
  readonly amount: number;
  readonly direction: TransactionDirection;
  /** Absent where BankOne sent a date this module will not guess at. */
  readonly occurredAt: Date | undefined;
  readonly narration: string | undefined;
  readonly reference: string | undefined;
}

export class UnreadableTransactionError extends Error {
  public override readonly name = "UnreadableTransactionError";

  public constructor(reason: string) {
    super(
      `BankOne returned a transaction row the Middleware cannot read: ${reason}. ` +
        "Refusing rather than guessing — a list with a row quietly missing from " +
        "it tells a Customer a transaction did not happen.",
    );
  }
}

/**
 * The rows, out of whichever container BankOne wrapped them in.
 *
 * `undefined` means *this body is not a list of transactions* — which is a
 * different thing from an empty list, and the caller has to tell them apart:
 * one is a shape we do not understand, the other is a quiet month.
 */
export const transactionRowsIn = (body: unknown): readonly unknown[] | undefined => {
  if (Array.isArray(body)) return body;

  const wrapped = field(body, "Transactions", "Data", "Items", "Records", "Result");
  return Array.isArray(wrapped) ? wrapped : undefined;
};

/** Reads one row, or throws `UnreadableTransactionError`. */
export const readTransaction = (raw: unknown): AccountTransaction => {
  if (typeof raw !== "object" || raw === null) throw new UnreadableTransactionError("not an object");

  const rawAmount = field(raw, "Amount", "TransactionAmount");
  if (rawAmount === undefined) throw new UnreadableTransactionError("no amount on the row");

  let signed: number;
  try {
    signed = parseBankOneAmount(rawAmount);
  } catch (error) {
    throw new UnreadableTransactionError(
      error instanceof Error ? error.message : "unreadable amount",
    );
  }

  return {
    amount: Math.abs(signed),
    direction: readDirection(raw, signed),
    occurredAt: readTransactionDate(
      field(raw, "TransactionDate", "PostingDate", "ValueDate", "TransactionDateTime", "Date"),
    ),
    narration: nonEmpty(stringField(raw, "Narration", "Description", "TransactionDetails", "Remarks")),
    reference: nonEmpty(
      stringField(raw, "ReferenceID", "TransactionReference", "ReferenceNumber", "Reference"),
    ),
  };
};

/**
 * Which way the money went, from three sources in descending order of trust.
 *
 * 1. **A dedicated marker** — a field whose only job is to say Dr or Cr. A
 *    value in it this module does not recognise is worse than no field at all:
 *    it is BankOne speaking a vocabulary we do not have, and reading a debit as
 *    a credit is the single worst thing here. So it refuses.
 * 2. **An ambiguous one.** The guide lists `Type` beside `RecordType`, but in
 *    most banking APIs `Type` names a *category* — `POS`, `NIP`, `TRANSFER` —
 *    rather than a direction. It is therefore read only when it says something
 *    recognisable, and ignored otherwise, because killing a whole history read
 *    over a category name would be defending against the wrong thing.
 * 3. **The sign**, which is the other convention the guide's `Amount` column
 *    implies and the only information a row with no marker carries.
 *
 * The residual risk is named rather than hidden: a response with no marker and
 * no negative amount anywhere is indistinguishable from an account that only
 * ever received money. Confirming which needs the entitlement and a funded
 * account with real history — ticket 16, Appendix A.5.
 */
const readDirection = (raw: unknown, signed: number): TransactionDirection => {
  const dedicated = stringField(raw, "RecordType", "DrCr", "CrDr", "DebitCreditIndicator");
  if (dedicated !== undefined) {
    const direction = directionOf(dedicated);
    if (direction) return direction;
    throw new UnreadableTransactionError(
      `unrecognised credit/debit marker ${JSON.stringify(dedicated)}`,
    );
  }

  const ambiguous = stringField(raw, "Type", "TransactionType");
  return (ambiguous !== undefined ? directionOf(ambiguous) : undefined) ?? (signed < 0 ? "debit" : "credit");
};

const directionOf = (marker: string): TransactionDirection | undefined => {
  const normalised = marker.trim().toLowerCase().replace(/[^a-z]/g, "");
  if (CREDIT_MARKERS.has(normalised)) return "credit";
  if (DEBIT_MARKERS.has(normalised)) return "debit";
  return undefined;
};

const CREDIT_MARKERS = new Set(["c", "cr", "credit", "inflow", "deposit"]);
const DEBIT_MARKERS = new Set(["d", "dr", "debit", "outflow", "withdrawal"]);

/**
 * A BankOne date, in the two forms that can be read without inventing one.
 *
 * ISO-8601 naming no timezone is read as UTC. BankOne names none and the
 * Middleware runs in none either — the alternative is a figure that moves when
 * the container's `TZ` changes, which is worse than a documented convention.
 *
 * `20/08/2026` gets `undefined`, on purpose. `dd/MM` and `MM/dd` are the same
 * nine characters, and a date the platform guessed is not a date.
 */
export const readTransactionDate = (value: unknown): Date | undefined => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value;
  if (typeof value === "number") return finite(new Date(value));
  if (typeof value !== "string") return undefined;

  const trimmed = value.trim();

  // `/Date(1755700000000)/`, optionally with an offset ASP.NET appends.
  const aspNet = /^\/Date\((-?\d+)([+-]\d{4})?\)\/$/.exec(trimmed);
  if (aspNet?.[1] !== undefined) return finite(new Date(Number(aspNet[1])));

  if (!ISO_ISH.test(trimmed)) return undefined;
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/.test(trimmed) ? trimmed : `${trimmed.replace(" ", "T")}Z`;
  return finite(new Date(zoned));
};

const ISO_ISH = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?(?:Z|[+-]\d{2}:?\d{2})?$/;

const finite = (date: Date): Date | undefined => (Number.isNaN(date.getTime()) ? undefined : date);

const nonEmpty = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

/**
 * How far back a Customer asked to look.
 *
 * An enum rather than a date range: a model emitting arbitrary dates is a model
 * we would have to validate dates from, and no Customer says "between the 3rd
 * and the 19th" to their bank.
 *
 * It sits in its own file because both halves of this package need it — the
 * Intent that carries the request, and the outcome that answers it — and a
 * shared constant is cheaper than the import cycle the alternative would be.
 */
export const TRANSACTION_PERIODS = [
  "today",
  "last_week",
  "last_month",
  "last_three_months",
] as const;

export type TransactionPeriod = (typeof TRANSACTION_PERIODS)[number];

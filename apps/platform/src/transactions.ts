import { formatNaira, type TransactionPeriod, type TransactionRow } from "@avni/intent";

/**
 * What happened on the account, as a Customer reads it on WhatsApp.
 *
 * Three decisions live here:
 *
 * - **"in" and "out" rather than `+`/`-`.** A minus sign in front of a naira
 *   figure is ambiguous at a glance and invisible on some handsets.
 * - **A row with no date still appears.** The Middleware sends `occurredAt`
 *   undefined where BankOne gave a date it would not guess at, and a
 *   transaction the platform cannot date is still a transaction that happened.
 * - **The narration is scrubbed of newlines.** It is the one string here the
 *   Bank did not write — anyone who can send a Customer ₦100 chooses what it
 *   says — and a narration containing line breaks could otherwise draw rows
 *   that are not there. It is shown to no model either way.
 */

const PERIOD_WORDS: Record<TransactionPeriod, string> = {
  today: "today",
  last_week: "in the last week",
  last_month: "in the last month",
  last_three_months: "in the last three months",
};

/** Long enough for a real narration, short enough not to become the message. */
const NARRATION_LIMIT = 60;

export const describeTransactions = (
  period: TransactionPeriod,
  rows: readonly TransactionRow[],
): string => {
  const when = PERIOD_WORDS[period];

  // An empty list is an answer, and a different one from "I cannot get that".
  if (rows.length === 0) return `Nothing has happened on your account ${when}.`;

  // **"Your most recent", not "what happened".** The Middleware hands over the
  // ten newest rows and no count of the rest, so a heading promising the whole
  // period would be false for any busier account — and a Customer hunting a
  // transaction that is not in the list would conclude it never happened.
  const lines = rows.map(describeRow);
  return [`Here are your most recent transactions ${when}:`, "", ...lines].join("\n");
};

const describeRow = (row: TransactionRow): string =>
  [dayOf(row.occurredAt), `${formatNaira(row.amount)} ${row.direction === "credit" ? "in" : "out"}`, oneLine(row.narration)]
    .filter((part): part is string => part !== undefined)
    .join(" · ");

/** `20 Aug`. The year is noise on a list that never reaches back a year. */
const dayOf = (occurredAt: string | undefined): string | undefined => {
  if (!occurredAt) return undefined;

  const when = new Date(occurredAt);
  if (Number.isNaN(when.getTime())) return undefined;

  return when.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
};

/** Collapses a narration to one line and caps it. Never trusts its contents. */
const oneLine = (narration: string | undefined): string | undefined => {
  const collapsed = narration?.replace(/\s+/g, " ").trim();
  if (!collapsed) return undefined;

  return collapsed.length > NARRATION_LIMIT
    ? `${collapsed.slice(0, NARRATION_LIMIT - 1).trimEnd()}…`
    : collapsed;
};

/**
 * Turning what the Middleware answered into what a Support Officer reads.
 *
 * The last step of the rule that starts in the BankOne adapter: BankOne sends
 * `"1,000,000.00"`, the Middleware parses it to the number `1000000` under the
 * separator-stripping rule, and this turns that number back into something a
 * human reads. **No BankOne string is ever rendered.** A screen that echoed the
 * wire format would be a screen that never noticed the day the wire format
 * changed — and `parseFloat("1,000,000.00")` is `1`, which is the shape of that
 * failure.
 */

/**
 * Two decimal places, always.
 *
 * `₦1,000,000` and `₦1,000,000.00` are the same money, but a column of balances
 * where some carry kobo and some do not is a column somebody misreads at a
 * glance.
 */
export const formatNaira = (naira: number): string =>
  `₦${naira.toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * An amount with which way it went.
 *
 * The direction is a **word** rather than a sign or a colour. A minus sign is a
 * character an eye skips at the end of a long day, and a colour is the first
 * thing a screenshot pasted into a complaint loses.
 */
export const formatMovement = (amount: number, direction: "credit" | "debit"): string =>
  `${formatNaira(amount)} ${direction === "credit" ? "in" : "out"}`;

/**
 * When something happened, in the Bank's own timezone.
 *
 * West Africa Time throughout, because an Officer reading a timestamp is
 * comparing it against what a Customer is telling them on the telephone, and
 * that Customer is in Lagos. WAT observes no daylight saving, so this is exact
 * rather than approximate — the same reason the Middleware's own day boundary
 * is fixed at UTC+1.
 *
 * **An absent date says so.** BankOne can send `20/08/2026`, which is either the
 * 20th of August or the 8th of the 20th month; the Middleware drops the date and
 * keeps the row rather than inventing one, and this is where that decision
 * becomes visible instead of showing up as a blank cell.
 */
export const formatWhen = (iso: string | undefined): string =>
  iso === undefined
    ? "date unreadable"
    : new Date(iso).toLocaleString("en-NG", {
        timeZone: "Africa/Lagos",
        dateStyle: "medium",
        timeStyle: "short",
      });

/** How far back the history screen is looking, in the Officer's words. */
export const PERIOD_WORDS = {
  today: "Today",
  last_week: "Last week",
  last_month: "Last month",
  last_three_months: "Last three months",
} as const;

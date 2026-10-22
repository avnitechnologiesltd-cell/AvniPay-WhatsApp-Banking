import type { TransactionPeriod } from "@avni/intent";

import type { TransactionWindow } from "../bankone/adapter";

/**
 * The Customer's period, resolved to two instants.
 *
 * The Intent carries an enum rather than dates, so this is where *"last month"*
 * becomes a span — in the **Middleware**, from the Middleware's clock. The
 * Orchestration Layer never names a date, which is one fewer value a model can
 * be talked into choosing.
 *
 * One rule for all four: back to the **start of the day** N days ago, up to now.
 * A Customer who asks what happened today at 9am means since midnight, not since
 * 9am yesterday, and the same instinct reads *"last week"* as seven whole days
 * rather than 168 hours ending at breakfast.
 */
const DAYS_BACK: Record<TransactionPeriod, number> = {
  today: 0,
  last_week: 7,
  last_month: 30,
  last_three_months: 90,
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * **The day boundary is Lagos's, not the container's.**
 *
 * West Africa Time is UTC+1 and observes no daylight saving, so a fixed offset
 * is exact here rather than an approximation — and it is a property of the
 * Bank's customers rather than of the deployment, which is why it is a constant
 * and not configuration. Computing midnight in UTC instead would silently drop
 * a Customer's 00:30 transfer out of *"today"*, which is precisely the hour
 * somebody checks what they did last night.
 */
const WAT_OFFSET_MS = 60 * 60 * 1000;

export const windowFor = (period: TransactionPeriod, now: Date): TransactionWindow => {
  const lagos = new Date(now.getTime() + WAT_OFFSET_MS);
  const startOfToday =
    Date.UTC(lagos.getUTCFullYear(), lagos.getUTCMonth(), lagos.getUTCDate()) - WAT_OFFSET_MS;

  return {
    from: new Date(startOfToday - DAYS_BACK[period] * DAY_MS),
    to: now,
  };
};

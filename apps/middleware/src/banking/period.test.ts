import { describe, expect, it } from "vitest";

import { windowFor } from "./period";

/**
 * The Intent names a period; the Middleware names the dates. That split is the
 * point — the Orchestration Layer never emits a date, so there is no date a
 * model can be talked into choosing.
 */

/** 10:15 in Lagos, which is the clock the Customer is reading. */
const NOW = new Date("2026-08-20T09:15:00Z");

describe("windowFor", () => {
  it("reads today as since midnight in Lagos, not as the last 24 hours", () => {
    // A Customer asking at 10am what happened today means since midnight. The
    // alternative quietly includes yesterday evening and excludes nothing.
    expect(windowFor("today", NOW)).toEqual({
      from: new Date("2026-08-19T23:00:00Z"),
      to: NOW,
    });
  });

  it("does not lose a Customer's small-hours transfer out of today", () => {
    // 00:30 in Lagos is 23:30 UTC the day before. A window built on UTC
    // midnight excludes it, and that is exactly the hour somebody checks what
    // they did last night.
    const halfPastMidnightInLagos = new Date("2026-08-19T23:30:00Z");

    const { from } = windowFor("today", new Date("2026-08-20T06:00:00Z"));

    expect(from.getTime()).toBeLessThanOrEqual(halfPastMidnightInLagos.getTime());
  });

  it.each([
    ["last_week", "2026-08-12T23:00:00Z"],
    ["last_month", "2026-07-20T23:00:00Z"],
    ["last_three_months", "2026-05-21T23:00:00Z"],
  ] as const)("reaches back whole days for %s", (period, from) => {
    expect(windowFor(period, NOW)).toEqual({ from: new Date(from), to: NOW });
  });

  it("never ends in the future", () => {
    for (const period of ["today", "last_week", "last_month", "last_three_months"] as const) {
      const window = windowFor(period, NOW);
      expect(window.to.getTime()).toBe(NOW.getTime());
      expect(window.from.getTime()).toBeLessThanOrEqual(window.to.getTime());
    }
  });
});

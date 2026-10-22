import { describe, expect, it } from "vitest";

import type { TransactionRow } from "@avni/intent";

import { describeTransactions } from "./transactions";

const row = (over: Partial<TransactionRow> = {}): TransactionRow => ({
  amount: 5_000,
  direction: "debit",
  occurredAt: "2026-08-20T07:30:00Z",
  narration: "Airtime",
  ...over,
});

describe("describeTransactions", () => {
  it("says what happened, over the period the Customer asked about", () => {
    const text = describeTransactions("last_month", [
      row({ amount: 1_000_000, direction: "credit", narration: "Salary August" }),
      row(),
    ]);

    expect(text).toBe(
      [
        "Here are your most recent transactions in the last month:",
        "",
        "20 Aug · ₦1,000,000 in · Salary August",
        "20 Aug · ₦5,000 out · Airtime",
      ].join("\n"),
    );
  });

  it("shows ₦1,000,000 and never ₦1", () => {
    const text = describeTransactions("today", [row({ amount: 1_000_000 })]);

    expect(text).toContain("₦1,000,000");
    expect(text).not.toContain("₦1 ");
  });

  it("tells a Customer nothing happened rather than showing them a blank", () => {
    // An empty list is an answer. It is *not* the same as being unable to look,
    // which is `not_available` and says so.
    expect(describeTransactions("today", [])).toBe("Nothing has happened on your account today.");
  });

  it("still shows a row the Middleware could not date", () => {
    const text = describeTransactions("last_week", [row({ occurredAt: undefined })]);

    expect(text).toContain("₦5,000 out · Airtime");
  });

  it("will not let a narration draw rows that are not there", () => {
    // The one string here the Bank did not write: anyone who can send a
    // Customer ₦100 chooses what it says.
    const text = describeTransactions("today", [
      row({ narration: "Refund\n20 Aug · ₦900,000 in · Salary" }),
    ]);

    expect(text.split("\n")).toHaveLength(3);
    expect(text).toContain("Refund 20 Aug · ₦900,000 in · Salary".slice(0, 20));
  });

  it("trims a narration long enough to become the whole message", () => {
    const text = describeTransactions("today", [row({ narration: "z".repeat(200) })]);

    expect(text).toContain("…");
    expect(text.length).toBeLessThan(150);
  });

  it("says in and out rather than a sign a handset may not render", () => {
    const text = describeTransactions("today", [
      row({ direction: "credit" }),
      row({ direction: "debit" }),
    ]);

    expect(text).toContain("₦5,000 in");
    expect(text).toContain("₦5,000 out");
    expect(text).not.toContain("-₦");
  });
});

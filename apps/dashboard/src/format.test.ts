import { describe, expect, it } from "vitest";

import { formatMovement, formatNaira, formatWhen } from "./format";

describe("money on a Support Officer's screen", () => {
  it("shows a million naira as a million naira", () => {
    // The end of the rule that starts at the adapter. BankOne sent
    // `"1,000,000.00"`, the Middleware answered the number, and this is what
    // the Officer reads. `parseFloat` on that string is `1`.
    expect(formatNaira(1_000_000)).toBe("₦1,000,000.00");
  });

  it("always carries kobo, so a column of balances reads straight", () => {
    expect(formatNaira(0)).toBe("₦0.00");
    expect(formatNaira(999)).toBe("₦999.00");
    expect(formatNaira(12.5)).toBe("₦12.50");
  });

  it("says which way the money went in a word", () => {
    expect(formatMovement(5_000, "debit")).toBe("₦5,000.00 out");
    expect(formatMovement(1_000_000, "credit")).toBe("₦1,000,000.00 in");
  });
});

describe("when something happened", () => {
  it("is read in Lagos, because that is where the Customer is", () => {
    // 23:30 UTC is half past midnight the next day in Lagos, and that is the
    // hour somebody rings up about what they did last night.
    expect(formatWhen("2026-08-19T23:30:00Z")).toContain("20 Aug 2026");
  });

  it("says the date could not be read rather than leaving a blank", () => {
    // BankOne can send `20/08/2026`, which is two different dates. The
    // Middleware keeps the row and drops the date; a blank cell here would read
    // as a transaction with nothing wrong with it.
    expect(formatWhen(undefined)).toBe("date unreadable");
  });
});

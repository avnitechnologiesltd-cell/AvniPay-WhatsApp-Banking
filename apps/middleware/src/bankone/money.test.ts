import { describe, expect, it } from "vitest";

import { parseBankOneAmount } from "./money";

/**
 * The single most dangerous line in the system.
 *
 * `parseFloat("1,000,000.00")` is `1` in JavaScript. A Customer with ₦1,000,000
 * would be told they have ₦1, and every threshold downstream would be wrong —
 * silently, and only above ₦1,000, so small-value testing never catches it.
 */
describe("parseBankOneAmount", () => {
  it("reads a balance with thousands separators", () => {
    expect(parseBankOneAmount("1,000,000.00")).toBe(1_000_000);
    expect(parseBankOneAmount("1,000.00")).toBe(1000);
    expect(parseBankOneAmount("12,345.67")).toBe(12_345.67);
  });

  it("does not become 1", () => {
    // Stated as its own case because it is the failure, not merely an example.
    expect(parseBankOneAmount("1,000,000.00")).not.toBe(1);
  });

  it("reads a balance without separators", () => {
    expect(parseBankOneAmount("1500.00")).toBe(1500);
    expect(parseBankOneAmount("0.00")).toBe(0);
    expect(parseBankOneAmount("999.50")).toBe(999.5);
  });

  it("treats the value as naira and never divides by 100", () => {
    expect(parseBankOneAmount("1500.00")).toBe(1500);
    expect(parseBankOneAmount("10")).toBe(10);
  });

  it("accepts a number BankOne sent unquoted", () => {
    expect(parseBankOneAmount(1500)).toBe(1500);
    expect(parseBankOneAmount(0)).toBe(0);
  });

  it("tolerates surrounding whitespace and a currency symbol", () => {
    expect(parseBankOneAmount(" 1,000.00 ")).toBe(1000);
    expect(parseBankOneAmount("₦1,000.00")).toBe(1000);
  });

  it("reads a negative balance rather than losing the sign", () => {
    expect(parseBankOneAmount("-1,500.00")).toBe(-1500);
  });

  it("refuses a value it cannot read rather than guessing zero", () => {
    // Returning 0 for an unreadable balance would tell a Customer they have
    // nothing, which is a wrong answer wearing the costume of a right one.
    for (const value of ["", "  ", "not a number", null, undefined, {}, "1,00,0.0.0"]) {
      expect(() => parseBankOneAmount(value)).toThrow();
    }
  });

  it("refuses a value with no digits at all", () => {
    expect(() => parseBankOneAmount(",,,")).toThrow();
    expect(() => parseBankOneAmount("₦")).toThrow();
  });
});

import { describe, expect, it } from "vitest";

import { isWellFormedNuban, nubanCheckDigit } from "./nuban";

/**
 * Two synthetic account numbers, built to carry a valid check digit under bank
 * code `030` with the 2010 weight vector. They are the same pair the rest of
 * the tests and the reference docs use.
 */
const BANK_CODE = "030";
const FIRST = "2024000153";
const SECOND = "2024000263";

describe("the CBN check digit", () => {
  it("is what both reference account numbers carry", () => {
    expect(nubanCheckDigit(BANK_CODE, FIRST.slice(0, 9))).toBe(3);
    expect(nubanCheckDigit(BANK_CODE, SECOND.slice(0, 9))).toBe(3);
  });

  it("accepts both of them whole", () => {
    expect(isWellFormedNuban(BANK_CODE, FIRST)).toBe(true);
    expect(isWellFormedNuban(BANK_CODE, SECOND)).toBe(true);
  });
});

describe("a mistyped account number", () => {
  it("is caught for almost every single-digit slip", () => {
    // The check is not a proof — 1 in 10 collides by construction — but the
    // Customer this exists for mistyped one digit, and this is how often that
    // costs them nothing.
    const slips: string[] = [];
    for (let position = 0; position < 10; position += 1) {
      for (let digit = 0; digit <= 9; digit += 1) {
        if (Number(FIRST[position]) === digit) continue;
        slips.push(`${FIRST.slice(0, position)}${digit}${FIRST.slice(position + 1)}`);
      }
    }

    const caught = slips.filter((slip) => !isWellFormedNuban(BANK_CODE, slip));
    expect(caught.length / slips.length).toBeGreaterThan(0.85);
  });

  it("is caught when two adjacent digits are transposed", () => {
    // 01 53 -> 01 35. The commonest typo after a wrong digit.
    expect(isWellFormedNuban(BANK_CODE, "2024000135")).toBe(false);
  });

  it("is caught when it is the wrong length, or not digits at all", () => {
    for (const wrong of ["", "202400015", "20240001530", "20240001_3", "abcdefghij"]) {
      expect(isWellFormedNuban(BANK_CODE, wrong)).toBe(false);
    }
  });
});

describe("the bank code", () => {
  it("changes the answer, which is why it is configuration", () => {
    // The same NUBAN under a different bank's code is a different account, and
    // pointing this at the wrong three digits would reject every real Customer.
    expect(isWellFormedNuban("058", FIRST)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import { MINIMUM_SEARCH, matchingBeneficiaries, normaliseName, tidy } from "./matching";

/**
 * The one place a Customer's words are turned into somebody's account number by
 * inference rather than instruction, so every case below is written as *who
 * would get paid*.
 */

const saved = (label: string, nameAtSave: string, lastUsedAt = new Date(0)) =>
  ({ label, nameAtSave, lastUsedAt }) as const;

const MUSA = saved("Musa", "MUSA IBRAHIM ADEYEMI");
const CHIDI = saved("", "CHIDI EZE");
const ADE = saved("Ade at work", "ADEBAYO OKONKWO");

describe("tidying what somebody typed", () => {
  it("collapses runs of space and trims, without folding case", () => {
    // What is *stored* keeps the Customer's own capitalisation; only what is
    // compared is folded, which is the whole of the difference below.
    expect(tidy("  Musa   Ibrahim ")).toBe("Musa Ibrahim");
  });

  it("strips the non-printing characters a paste brings with it", () => {
    expect(tidy("Mu​sa ")).toBe("Musa");
    expect(tidy("Mu\u0000sa")).toBe("Musa");
  });
});

describe("normalising a name for comparison", () => {
  it("is tidying, and then folding case", () => {
    expect(normaliseName("  Musa   IBRAHIM ")).toBe("musa ibrahim");
    expect(normaliseName("Mu​sa")).toBe("musa");
  });
});

describe("matching what a Customer said against what they saved", () => {
  it("matches the Customer's own label, whatever the case", () => {
    expect(matchingBeneficiaries([MUSA], "musa")).toEqual([MUSA]);
    expect(matchingBeneficiaries([MUSA], "MUSA")).toEqual([MUSA]);
  });

  it("matches the bank's own name for the account, which was never a label", () => {
    // The common case the store would otherwise miss: a Customer says a surname
    // nobody ever typed into the "Save as" field.
    expect(matchingBeneficiaries([CHIDI], "chidi")).toEqual([CHIDI]);
    expect(matchingBeneficiaries([MUSA], "adeyemi")).toEqual([MUSA]);
  });

  it("matches inside a name as well as at the front of one", () => {
    expect(matchingBeneficiaries([ADE], "okonkwo")).toEqual([ADE]);
    expect(matchingBeneficiaries([ADE], "ade")).toEqual([ADE]);
  });

  it("takes two characters, because Nigerian short forms are often two letters", () => {
    expect(matchingBeneficiaries([MUSA], "mu")).toEqual([MUSA]);
    // One character would match most of a store, and the Customer would be
    // choosing from a list that means nothing.
    expect(matchingBeneficiaries([MUSA], "m")).toEqual([]);
    expect(MINIMUM_SEARCH).toBe(2);
  });

  it("tolerates no typo at all", () => {
    // A typo tolerance buys one avoided re-type and pays in wrong-person risk.
    // The Confirmation screen is the only thing standing between a wrong match
    // and a wrong debit, and it should not have to be.
    expect(matchingBeneficiaries([MUSA], "mussa")).toEqual([]);
    expect(matchingBeneficiaries([MUSA], "muza")).toEqual([]);
  });

  it("returns several when several match, most recently used first", () => {
    const older = saved("Musa", "MUSA BELLO", new Date(1_000));
    const newer = saved("Musa", "MUSA IBRAHIM", new Date(2_000));

    expect(matchingBeneficiaries([older, newer], "Musa")).toEqual([newer, older]);
  });

  it("caps the list rather than asking a Customer to scroll near-identical rows", () => {
    const many = Array.from({ length: 30 }, (_, index) =>
      saved(`Musa ${index}`, "MUSA BELLO", new Date(index)),
    );

    // Eight, and deliberately not the ten a WhatsApp list message would impose:
    // rendering this inside a Flow is what escaped that ceiling.
    expect(matchingBeneficiaries(many, "musa")).toHaveLength(8);
    // Newest first, so a cap drops the ones least likely to be meant.
    expect(matchingBeneficiaries(many, "musa")[0]).toBe(many[29]);
  });

  it("matches nothing at all on an empty store, which is every first transfer", () => {
    expect(matchingBeneficiaries([], "musa")).toEqual([]);
  });
});

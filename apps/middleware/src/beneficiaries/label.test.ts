import { describe, expect, it } from "vitest";

import { LABEL_WORDS, MOST_LABEL_CHARACTERS, labelProblem } from "./label";

describe("what may be saved as a label", () => {
  it("accepts an ordinary name, and no label at all", () => {
    expect(labelProblem("Musa")).toBeUndefined();
    // Optional, always. A transfer is not held up by a field nobody filled in.
    expect(labelProblem("")).toBeUndefined();
    // Nor by one that was only ever whitespace and a stray paste artefact.
    expect(labelProblem("  ​ ")).toBeUndefined();
  });

  it("refuses more than twenty-four characters", () => {
    expect(MOST_LABEL_CHARACTERS).toBe(24);
    expect(labelProblem("a".repeat(24))).toBeUndefined();
    expect(labelProblem("a".repeat(25))).toBe(LABEL_WORDS.tooLong);
  });

  it("refuses a label that is all digits", () => {
    // So that "send 5000 to 2124955312" always means the account number and
    // never somebody's nickname for a person.
    expect(labelProblem("2124955312")).toBe(LABEL_WORDS.allDigits);
    expect(labelProblem(" 2124 9553 12 ")).toBe(LABEL_WORDS.allDigits);
    expect(labelProblem("Musa 2")).toBeUndefined();
  });

  it("refuses a known bank's name, however it is spelled", () => {
    // A saved recipient called "GTBank" is a phrase a Customer would read as
    // the institution rather than as a person, on a screen whose whole job is
    // telling them who is about to be paid.
    expect(labelProblem("GTBank")).toBe(LABEL_WORDS.namesABank);
    expect(labelProblem("gtb")).toBe(LABEL_WORDS.namesABank);
    expect(labelProblem("Access Bank")).toBe(LABEL_WORDS.namesABank);
    // The whole label has to name a bank. This one names a person at one.
    expect(labelProblem("Musa at GTBank")).toBeUndefined();
  });

  it("judges the label after it is tidied, not as it was typed", () => {
    // Twenty-four characters plus a trailing space is twenty-four characters.
    expect(labelProblem(` ${"a".repeat(24)} `)).toBeUndefined();
  });
});

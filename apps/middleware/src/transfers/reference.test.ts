import { describe, expect, it } from "vitest";

import { REFERENCE_ALPHABET, REFERENCE_LENGTH, mintReference } from "./reference";

describe("the transfer reference", () => {
  it("is at most twelve characters, which is what BankOne accepts", () => {
    // Longer is rejected outright with "... Max Length 12", which rules out a
    // bare UUID — the obvious choice, and the wrong one.
    expect(REFERENCE_LENGTH).toBeLessThanOrEqual(12);
    expect(mintReference()).toHaveLength(REFERENCE_LENGTH);
  });

  it("uses characters that survive a core banking system and a phone call", () => {
    // No case distinction, no `+`, no `/`, and none of the letters a Support
    // Officer would mishear a digit as — I, L, O and U are all absent.
    expect(REFERENCE_ALPHABET).not.toMatch(/[ILOU]/);

    for (let attempt = 0; attempt < 200; attempt += 1) {
      expect(mintReference()).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]+$/);
    }
  });

  it("maps every byte value onto the alphabet without favouring any of it", () => {
    // The unbiasedness is a property of the two constants rather than of a
    // sample, so it is asserted as one: 256 divides by the alphabet's length
    // exactly, which is what makes `byte % length` reach every character the
    // same number of times. An alphabet of 26 or 36 would silently favour its
    // first few characters, and no amount of sampling states *why*.
    expect(256 % REFERENCE_ALPHABET.length).toBe(0);

    const counts = new Map<string, number>();
    for (let byte = 0; byte < 256; byte += 1) {
      const character = REFERENCE_ALPHABET[byte % REFERENCE_ALPHABET.length] as string;
      counts.set(character, (counts.get(character) ?? 0) + 1);
    }

    expect(counts.size).toBe(REFERENCE_ALPHABET.length);
    expect([...counts.values()].every((count) => count === 8)).toBe(true);
  });

  it("does not repeat itself", () => {
    // Sixty bits. The unique index on the reference is what actually enforces
    // this — a duplicate reference is a debit that could happen twice — but a
    // minter that collided routinely would make that index an outage.
    const minted = new Set(Array.from({ length: 2000 }, () => mintReference()));

    expect(minted.size).toBe(2000);
  });
});

import { describe, expect, it } from "vitest";

import { decoyDestinations } from "./destinations";

const SECRET = "a-long-enough-decoy-secret";
const UNKNOWN = "2024000153";

describe("decoy destinations", () => {
  it("are identical on a second probe of the same account", () => {
    // The one property that makes them worth having. Random decoys would differ
    // between two probes of the same number, and nothing else in the system
    // does — the randomness would be the oracle.
    expect(decoyDestinations(SECRET, UNKNOWN)).toEqual(decoyDestinations(SECRET, UNKNOWN));
  });

  it("differ between accounts", () => {
    const one = decoyDestinations(SECRET, UNKNOWN);
    const other = decoyDestinations(SECRET, "2024000263");

    expect(JSON.stringify(one)).not.toBe(JSON.stringify(other));
  });

  it("cannot be derived without the key", () => {
    // Deterministic on the account number alone would let anyone who has read
    // the source compute a fabricated screen and recognise it.
    const theirs = decoyDestinations("a-different-secret-entirely", UNKNOWN);

    expect(JSON.stringify(theirs)).not.toBe(JSON.stringify(decoyDestinations(SECRET, UNKNOWN)));
  });

  it("mask exactly the way the Bank's own do", () => {
    // A decoy that masks differently announces itself. This is the Bank's
    // recommended masking from bank-identity-api.md §4.1, and the shapes have
    // to be indistinguishable rather than merely similar.
    for (const accountNumber of sampleAccounts()) {
      for (const destination of decoyDestinations(SECRET, accountNumber)) {
        if (destination.kind === "phone") {
          expect(destination.masked).toMatch(/^••• ••• \d{4}$/);
        } else {
          expect(destination.masked).toMatch(/^[a-z]•••@[a-z]•••\.com$/);
        }
      }
    }
  });

  it("never leak a full number, because there is none to leak", () => {
    for (const accountNumber of sampleAccounts()) {
      for (const destination of decoyDestinations(SECRET, accountNumber)) {
        // No leading 0803, no full domain: the prefix hands over the network
        // operator of an account that may not be the requester's.
        expect(destination.masked).not.toMatch(/\d{5,}/);
        expect(destination.masked).not.toContain(accountNumber);
      }
    }
  });

  it("always offer somewhere to send, and never an implausible crowd", () => {
    for (const accountNumber of sampleAccounts()) {
      const destinations = decoyDestinations(SECRET, accountNumber);
      expect(destinations.length).toBeGreaterThanOrEqual(1);
      expect(destinations.length).toBeLessThanOrEqual(3);
    }
  });

  it("carry opaque positional ids, like the Bank's", () => {
    const destinations = decoyDestinations(SECRET, UNKNOWN);

    expect(destinations.map((destination) => destination.id)).toEqual(
      destinations.map((_, index) => `d${index + 1}`),
    );
  });
});

const sampleAccounts = (): readonly string[] =>
  Array.from({ length: 200 }, (_, index) => String(1_100_000_000 + index));

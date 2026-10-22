import { randomBytes } from "node:crypto";

/**
 * The transfer reference, minted by the **Middleware** and by nothing else.
 *
 * Two constraints, and they pull against each other. BankOne caps
 * `RetrievalReference` at **12 characters** — longer is rejected outright — and
 * **nothing documents BankOne deduplicating on it** (Appendix A.5), so the
 * Middleware must dedupe itself. Twelve characters rules out a bare UUID, and
 * the same value is reused verbatim for the status query, which is what makes
 * *"what happened to that transfer"* an answerable question at all.
 */

/** BankOne's cap. Longer is refused with `"... Max Length 12"`. */
export const REFERENCE_LENGTH = 12;

/**
 * Crockford's base32: digits and uppercase letters with `I`, `L`, `O` and `U`
 * removed.
 *
 * Uppercase alphanumerics because a reference travels through a core banking
 * system, a NIBSS session and a Customer reading it back over the telephone to a
 * Support Officer, and none of those is a good place for `+`, `/` or a case
 * distinction. Thirty-two characters divides 256 exactly, so a byte maps to a
 * character with no modulo bias to reason about.
 */
export const REFERENCE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * A fresh reference: 12 characters, 60 bits of randomness.
 *
 * Random rather than sequential, and carrying nothing about the transfer. A
 * reference that encoded an account number or a counter would be a reference
 * that leaks one, and this value ends up in BankOne's records, in NIBSS's, and
 * on a Customer's screen.
 *
 * Collision is not merely improbable, it is refused: the unique index on
 * `mandates.reference` is what actually enforces this, and the repository mints
 * again if Postgres says the value is taken.
 *
 * `randomBytes` is called directly rather than injected. The alphabet's length
 * divides 256 exactly, so the mapping below is unbiased for *every* byte value
 * — which is a property of the two constants and is asserted as one, rather than
 * by handing this function a fake generator and adding a production seam for a
 * test.
 */
export const mintReference = (): string => {
  let reference = "";
  for (const byte of randomBytes(REFERENCE_LENGTH)) {
    reference += REFERENCE_ALPHABET[byte % REFERENCE_ALPHABET.length];
  }
  return reference;
};

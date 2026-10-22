import { hashSecret, verifySecret } from "../secrets/argon2";

/**
 * **argon2id**, from `../secrets/argon2.ts` — the same primitives the
 * Transaction PIN is stored under.
 *
 * They live together rather than beside each caller because the prior art
 * separated them and got one of the two wrong:
 * `hashlib.sha256(password + _SECRET)` for the staff login, with one shared
 * static salt for every user, in the same repository that hashed the PIN
 * properly. A shared salt means two staff with the same password produce the
 * same hash, so a dump tells an attacker who to try first — and SHA-256 is fast
 * enough to make trying cheap.
 *
 * What stays here is the *password policy*, which is a staff question and not a
 * cryptographic one.
 */

export { needsRehash } from "../secrets/argon2";

export const hashPassword = (password: string): Promise<string> => hashSecret(password);

export const verifyPassword = (storedHash: string, password: string): Promise<boolean> =>
  verifySecret(storedHash, password);

/**
 * What a password must be before it is accepted.
 *
 * Length and nothing else. Composition rules — one capital, one symbol — push
 * people toward `Password1!` and are worse than useless; length is the only
 * requirement that reliably buys entropy. NIST dropped the rest years ago.
 */
export const MINIMUM_PASSWORD_LENGTH = 12;

export const passwordProblem = (password: string): string | undefined => {
  if (password.length < MINIMUM_PASSWORD_LENGTH) {
    return `must be at least ${MINIMUM_PASSWORD_LENGTH} characters`;
  }
  // Argon2 has no practical upper bound, but an unbounded input is a cheap way
  // to make the server do expensive work.
  if (password.length > 256) return "must be at most 256 characters";
  return undefined;
};

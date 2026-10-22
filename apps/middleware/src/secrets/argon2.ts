import { Algorithm, hash, verify } from "@node-rs/argon2";

/**
 * **The one place this platform says argon2id**, and the one place its cost
 * parameters are written down.
 *
 * Two secrets are hashed here — a staff password and a Customer's Transaction
 * PIN — and they are hashed the same way on purpose. The prior art is the
 * argument for keeping it in a single file: the same repository got the PIN
 * right and the staff login wrong, `hashlib.sha256(password + _SECRET)` with one
 * shared static salt, because the rule lived in whoever was writing that
 * afternoon rather than in the code.
 *
 * A Transaction PIN is the harder case of the two. Four digits is 10,000
 * possibilities; under a fast hash a database dump yields every Customer's PIN
 * in seconds, and the fact that the lockout is the real defence does not make
 * the backstop optional.
 *
 * The encoded output carries its own parameters and salt, so raising the cost
 * later needs no migration: existing hashes keep verifying under the parameters
 * they were made with, and `needsRehash` says which to upgrade on next use.
 */

/**
 * OWASP's floor for argon2id at the time of writing: 19 MiB, 2 iterations,
 * 1 degree of parallelism. Memory is the expensive axis for an attacker with
 * GPUs, which is why it is the one that matters most.
 */
export const ARGON2_PARAMETERS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export const hashSecret = (secret: string): Promise<string> => hash(secret, ARGON2_PARAMETERS);

/**
 * Never throws on a malformed hash — it answers `false`.
 *
 * A stored hash that will not parse must read as "wrong", not as a 500. The
 * alternative is an error path that tells an attacker they found a record whose
 * stored value is damaged.
 */
export const verifySecret = async (storedHash: string, secret: string): Promise<boolean> => {
  try {
    return await verify(storedHash, secret, ARGON2_PARAMETERS);
  } catch {
    return false;
  }
};

/** True when a hash was made with weaker parameters than we now use. */
export const needsRehash = (storedHash: string): boolean => {
  const match = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(storedHash);
  if (!match) return true;

  const [, memory, time, parallelism] = match;
  return (
    Number(memory) < ARGON2_PARAMETERS.memoryCost ||
    Number(time) < ARGON2_PARAMETERS.timeCost ||
    Number(parallelism) < ARGON2_PARAMETERS.parallelism
  );
};

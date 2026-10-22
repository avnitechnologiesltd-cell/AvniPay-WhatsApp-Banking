import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * **The one place this platform encrypts something it will need back.**
 *
 * Deliberately the smaller of two files in this directory. `argon2.ts` handles
 * every secret nobody is ever meant to recover — a staff password, a Customer's
 * Transaction PIN — and one-way is the right answer there precisely because a
 * database dump must not yield them.
 *
 * A signing secret is the other case. Verifying an HMAC needs the secret
 * itself, so an in-app chat signing secret has to survive a restart in a form
 * the Middleware can read. That makes reversible encryption correct here and
 * wrong three metres away, which is worth the two files.
 *
 * AES-256-GCM: authenticated, so a ciphertext somebody edited in the database
 * fails to open rather than decrypting to something else. **The key comes from
 * the environment and never from Postgres** — a dump carrying its own key is
 * obfuscation with the word encryption written on it.
 */

/** 96 bits, which is what GCM is specified and fastest for. */
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class SealedValueError extends Error {
  public override readonly name = "SealedValueError";
}

/**
 * Seals a value under `key`, returning one opaque string safe to store.
 *
 * A fresh random IV every time. Reusing one under GCM is catastrophic rather
 * than merely weak, and generating it here is what stops a caller supplying it.
 */
export const seal = (key: string, plaintext: string): string => {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", keyBytes(key), iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);

  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
};

/**
 * Opens what `seal` produced.
 *
 * Throws rather than answering `undefined`. A stored ciphertext that will not
 * open is the encryption key having changed or the row having been tampered
 * with, and neither is something to carry on past — unlike a password check,
 * where "wrong" is an ordinary answer.
 */
export const open = (key: string, sealed: string): string => {
  const raw = Buffer.from(sealed, "base64");
  if (raw.length <= IV_BYTES + TAG_BYTES) {
    throw new SealedValueError("the stored value is too short to be a sealed one");
  }

  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const body = raw.subarray(IV_BYTES + TAG_BYTES);

  try {
    const decipher = createDecipheriv("aes-256-gcm", keyBytes(key), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    // The reason is never more specific than this on purpose: an authentication
    // tag that did not verify and a key that is simply the wrong one are the
    // same event to anybody who should not be here.
    throw new SealedValueError("the stored value did not open under this key");
  }
};

const keyBytes = (key: string): Buffer => {
  const bytes = Buffer.from(key, "base64");
  // Configuration validates this at boot. Re-checked here because this function
  // is the one that would otherwise fail as an opaque OpenSSL error at the
  // moment a Customer opened the Bank's app.
  if (bytes.length !== 32) {
    throw new SealedValueError("the encryption key is not 32 bytes of base64");
  }
  return bytes;
};

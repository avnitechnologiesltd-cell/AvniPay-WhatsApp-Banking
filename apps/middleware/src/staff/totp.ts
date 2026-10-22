import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * TOTP — RFC 6238, on top of HOTP — RFC 4226.
 *
 * Implemented rather than depended on, for the same reason the Flows crypto
 * was ported rather than wrapped: it is ~40 lines of well-specified arithmetic
 * with **published test vectors**, and the vectors are what make it trustworthy.
 * A dependency here would be a supply-chain surface on the login that reaches
 * every Customer's data, bought to avoid writing a loop.
 *
 * `SHA-1` is not a mistake. RFC 6238's default and every authenticator app —
 * Google Authenticator, 1Password, Authy — assume it. HMAC-SHA1 is not affected
 * by SHA-1's collision weaknesses, which are about finding two colliding
 * messages rather than about forging a MAC under an unknown key.
 */

/** Six digits, because that is what an authenticator app shows. */
const DIGITS = 6;

/** Thirty seconds, RFC 6238's default. */
const PERIOD_SECONDS = 30;

/**
 * How many steps either side of now are accepted.
 *
 * One, so a code entered as it rolls over still works and a phone clock a few
 * seconds out is not a support ticket. That is a **90-second** window in total;
 * widening it further trades real security for a rare inconvenience.
 */
const DRIFT_STEPS = 1;

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32, which is what authenticator apps read. */
export const toBase32 = (bytes: Buffer): string => {
  let bits = 0;
  let value = 0;
  let output = "";

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];

  return output;
};

export const fromBase32 = (secret: string): Buffer => {
  const cleaned = secret.replace(/=+$/, "").replace(/\s/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const character of cleaned) {
    const index = BASE32.indexOf(character);
    if (index === -1) throw new Error("The secret is not base32.");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
};

/** A fresh 160-bit secret, which is what RFC 4226 recommends for SHA-1. */
export const generateTotpSecret = (): string => toBase32(randomBytes(20));

/**
 * HOTP — RFC 4226 §5.3. The dynamic truncation is the fiddly part: the low
 * nibble of the last byte picks a four-byte window, and the top bit of that
 * window is masked off so the result is the same on every platform.
 */
export const hotp = (secret: Buffer, counter: number): string => {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac("sha1", secret).update(message).digest();
  const offset = (digest[digest.length - 1] as number) & 0x0f;

  const truncated =
    (((digest[offset] as number) & 0x7f) << 24) |
    (((digest[offset + 1] as number) & 0xff) << 16) |
    (((digest[offset + 2] as number) & 0xff) << 8) |
    ((digest[offset + 3] as number) & 0xff);

  return (truncated % 10 ** DIGITS).toString().padStart(DIGITS, "0");
};

/** The step number for a moment in time. */
export const stepAt = (atMs: number): number => Math.floor(atMs / 1000 / PERIOD_SECONDS);

export const totp = (secret: string, atMs: number): string =>
  hotp(fromBase32(secret), stepAt(atMs));

/**
 * Whether `code` is valid now, allowing one step of drift either way.
 *
 * The comparison is constant-time. A six-digit code is small enough that a
 * timing side channel is worth closing rather than reasoning about.
 */
export const verifyTotp = (secret: string, code: string, atMs: number): boolean => {
  const offered = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(offered)) return false;

  const key = fromBase32(secret);
  const now = stepAt(atMs);

  let matched = false;
  for (let step = now - DRIFT_STEPS; step <= now + DRIFT_STEPS; step += 1) {
    const expected = Buffer.from(hotp(key, step), "utf8");
    const candidate = Buffer.from(offered, "utf8");
    // Deliberately not short-circuiting: every step is compared whether or not
    // an earlier one matched, so the time taken does not reveal which.
    if (expected.length === candidate.length && timingSafeEqual(expected, candidate)) {
      matched = true;
    }
  }

  return matched;
};

/** The `otpauth://` URI an authenticator app scans. */
export const totpEnrolmentUri = (
  secret: string,
  account: string,
  issuer: string,
): string => {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const parameters = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${parameters.toString()}`;
};

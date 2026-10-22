import { describe, expect, it } from "vitest";

import {
  fromBase32,
  generateTotpSecret,
  hotp,
  toBase32,
  totp,
  totpEnrolmentUri,
  verifyTotp,
} from "./totp";

/**
 * The vectors below are **published in the RFCs**, not produced by this code.
 * That is the whole reason to implement TOTP rather than depend on it: a wrong
 * implementation that agrees with itself passes every round-trip test and then
 * locks every Administrator out of the Dashboard.
 */

/** RFC 4226 Appendix D uses the ASCII secret "12345678901234567890". */
const RFC4226_SECRET = Buffer.from("12345678901234567890", "utf8");

/** RFC 4226 Appendix D, counters 0–9. */
const RFC4226_HOTP = [
  "755224",
  "287082",
  "359152",
  "969429",
  "338314",
  "254676",
  "287922",
  "162583",
  "399871",
  "520489",
];

/** RFC 6238 Appendix B, the SHA-1 rows. Times are seconds since the epoch. */
const RFC6238_TOTP: readonly [number, string][] = [
  [59, "287082"],
  [1_111_111_109, "081804"],
  [1_111_111_111, "050471"],
  [1_234_567_890, "005924"],
  [2_000_000_000, "279037"],
  [20_000_000_000, "353130"],
];

const RFC6238_SECRET_BASE32 = toBase32(RFC4226_SECRET);

describe("HOTP against RFC 4226 Appendix D", () => {
  it.each(RFC4226_HOTP.map((code, counter) => [counter, code] as const))(
    "counter %i produces %s",
    (counter, expected) => {
      expect(hotp(RFC4226_SECRET, counter)).toBe(expected);
    },
  );
});

describe("TOTP against RFC 6238 Appendix B", () => {
  it.each(RFC6238_TOTP)("at %i seconds produces %s", (seconds, expected) => {
    expect(totp(RFC6238_SECRET_BASE32, seconds * 1000)).toBe(expected);
  });

  it("stays correct past 2038, where a 32-bit counter would wrap", () => {
    // 20000000000 is the RFC's own guard against exactly that, which is why the
    // counter is written as a BigInt.
    expect(totp(RFC6238_SECRET_BASE32, 20_000_000_000 * 1000)).toBe("353130");
  });
});

describe("base32", () => {
  it("round-trips a secret", () => {
    const secret = generateTotpSecret();
    expect(toBase32(fromBase32(secret))).toBe(secret);
  });

  it("encodes the RFC's secret the way an authenticator app expects", () => {
    // "12345678901234567890" — the value every TOTP tutorial shows.
    expect(toBase32(RFC4226_SECRET)).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  });

  it("reads a secret back case-insensitively and ignoring padding and spaces", () => {
    // What somebody typing a secret off a screen actually produces.
    expect(fromBase32("gezdgnbvgy3tqojqgezdgnbvgy3tqojq")).toEqual(RFC4226_SECRET);
    expect(fromBase32("GEZDGNBV GY3TQOJQ GEZDGNBV GY3TQOJQ")).toEqual(RFC4226_SECRET);
  });

  it("refuses a secret that is not base32", () => {
    expect(() => fromBase32("not-base-32!")).toThrow();
  });
});

describe("generateTotpSecret", () => {
  it("produces 160 bits, which is what RFC 4226 recommends for SHA-1", () => {
    expect(fromBase32(generateTotpSecret())).toHaveLength(20);
  });

  it("produces a different secret every time", () => {
    const secrets = new Set(Array.from({ length: 20 }, () => generateTotpSecret()));
    expect(secrets.size).toBe(20);
  });
});

describe("verifyTotp", () => {
  const secret = RFC6238_SECRET_BASE32;
  const now = 1_111_111_111 * 1000;

  it("accepts the code for right now", () => {
    expect(verifyTotp(secret, "050471", now)).toBe(true);
  });

  it("accepts a code entered as it rolls over", () => {
    // One step either side, so a phone clock a few seconds out is not a
    // support ticket.
    expect(verifyTotp(secret, totp(secret, now - 30_000), now)).toBe(true);
    expect(verifyTotp(secret, totp(secret, now + 30_000), now)).toBe(true);
  });

  it("refuses a code two steps out", () => {
    // The window is 90 seconds in total and no wider.
    expect(verifyTotp(secret, totp(secret, now - 90_000), now)).toBe(false);
    expect(verifyTotp(secret, totp(secret, now + 90_000), now)).toBe(false);
  });

  it("refuses somebody else's code", () => {
    expect(verifyTotp(generateTotpSecret(), "050471", now)).toBe(false);
  });

  it("refuses anything that is not six digits", () => {
    for (const code of ["", "12345", "1234567", "abcdef", "05047a", "  ", "-50471"]) {
      expect(verifyTotp(secret, code, now)).toBe(false);
    }
  });

  it("ignores spaces, because an app shows the code as two groups of three", () => {
    expect(verifyTotp(secret, "050 471", now)).toBe(true);
  });

  it("does not accept a code that has expired", () => {
    // The property MFA exists for: a code seen over somebody's shoulder is
    // worthless a minute later.
    const captured = totp(secret, now);
    expect(verifyTotp(secret, captured, now + 5 * 60_000)).toBe(false);
  });
});

describe("totpEnrolmentUri", () => {
  it("carries what an authenticator app needs to scan", () => {
    const uri = totpEnrolmentUri("GEZDGNBVGY3TQOJQ", "ada@bank.example", "Example MFB");

    expect(uri.startsWith("otpauth://totp/")).toBe(true);
    expect(uri).toContain("secret=GEZDGNBVGY3TQOJQ");
    expect(uri).toContain("algorithm=SHA1");
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");
  });

  it("escapes an issuer and account that contain a colon or a space", () => {
    const uri = totpEnrolmentUri("GEZDGNBVGY3TQOJQ", "ada@bank.example", "Example MFB");

    // An unescaped label is how a QR code silently enrols against the wrong
    // account name.
    expect(uri).toContain("Example%20MFB%3Aada%40bank.example");
  });
});

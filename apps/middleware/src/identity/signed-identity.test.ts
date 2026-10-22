import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { signInAppIdentity, stripSignature, tamperWithAccountNumber } from "@avni/fakes";

import {
  CURRENT_CONTRACT_VERSION,
  MAXIMUM_ENVELOPE_LIFETIME_MS,
  signIdentityEnvelope,
  verifyIdentityEnvelope,
} from "./signed-identity";

/**
 * The envelope is the only thing standing between in-app chat and *"return any
 * Customer's balance and full transaction history to anyone who edits one
 * field"*. Every refusal below is that sentence, tested.
 *
 * The signer under test here is **the Bank's**, from `@avni/fakes` — an
 * independent implementation of a format we publish and have committed never to
 * break. A round trip through our own signer would prove only that it agrees
 * with itself.
 */

const SECRET = "a-signing-secret-the-dashboard-issued";
const OTHER_SECRET = "the-secret-issued-when-the-first-was-rotated";
const ACCOUNT = "0123456789";
const STRANGER = "9876543210";

const NOW = new Date("2026-08-22T10:00:00.000Z");
const LATER = new Date("2026-08-22T10:05:00.000Z");

const envelopeFor = (secret: string, options: { account?: string; expiresAt?: Date } = {}) =>
  signInAppIdentity(secret, {
    accountNumber: options.account ?? ACCOUNT,
    expiresAt: options.expiresAt ?? LATER,
  });

describe("an envelope the Bank's backend signed", () => {
  it("names the account it was signed over", () => {
    expect(verifyIdentityEnvelope(envelopeFor(SECRET), [SECRET], NOW)).toEqual({
      outcome: "verified",
      accountNumber: ACCOUNT,
    });
  });

  it("verifies against any live secret, so rotation has a window", () => {
    // The Bank's backend is still signing with the first while the second has
    // just been issued. Both work until one is deliberately retired.
    expect(
      verifyIdentityEnvelope(envelopeFor(SECRET), [OTHER_SECRET, SECRET], NOW),
    ).toMatchObject({ outcome: "verified" });
  });

  it("agrees byte for byte with the verifier's own signer", () => {
    // The two implementations exist to catch each other. If this fails, one of
    // them changed a published contract.
    expect(signIdentityEnvelope(SECRET, { accountNumber: ACCOUNT, expiresAt: LATER })).toBe(
      envelopeFor(SECRET),
    );
  });

  it("is pinned to a value, so the format cannot drift unnoticed", () => {
    // Not a vector from a standards body — this format is ours. It is pinned
    // because the Bank ships it inside a mobile application we cannot recall,
    // so a change here is a new contract version and never an edit.
    expect(
      signIdentityEnvelope(SECRET, {
        accountNumber: ACCOUNT,
        expiresAt: new Date(1_737_550_000 * 1000),
      }),
    ).toBe(
      "v1.eyJhY2NvdW50IjoiMDEyMzQ1Njc4OSIsImV4cCI6MTczNzU1MDAwMH0" +
        ".PfqYAmnZn9udIHto688iHt7Rvcs2--JNVUhI9tjBM78",
    );
  });
});

describe("an envelope that must not be accepted", () => {
  it("refuses an edited account number", () => {
    // The attack: the handset's owner rewrites one field and asks for somebody
    // else's money. The signature was made over the original.
    const edited = tamperWithAccountNumber(envelopeFor(SECRET), STRANGER);

    expect(verifyIdentityEnvelope(edited, [SECRET], NOW)).toEqual({
      outcome: "refused",
      reason: "unknown_secret",
    });
  });

  it("refuses an expired envelope", () => {
    const stale = envelopeFor(SECRET, { expiresAt: new Date("2026-08-22T09:59:00.000Z") });

    expect(verifyIdentityEnvelope(stale, [SECRET], NOW)).toEqual({
      outcome: "refused",
      reason: "expired",
    });
  });

  it("refuses one expiring exactly now", () => {
    expect(verifyIdentityEnvelope(envelopeFor(SECRET, { expiresAt: NOW }), [SECRET], NOW)).toEqual({
      outcome: "refused",
      reason: "expired",
    });
  });

  it("refuses one that claims to live longer than the ceiling", () => {
    // An envelope is a bearer credential for reading somebody's money. Without
    // a ceiling, one line in the Bank's backend — `exp: now + a year` — turns a
    // short-lived handle into a permanent key and nothing here would say so.
    const yearLong = envelopeFor(SECRET, {
      expiresAt: new Date(NOW.getTime() + 365 * 24 * 60 * 60 * 1000),
    });

    expect(verifyIdentityEnvelope(yearLong, [SECRET], NOW)).toEqual({
      outcome: "refused",
      reason: "lives_too_long",
    });
  });

  it("accepts one right at the ceiling", () => {
    const atTheLimit = envelopeFor(SECRET, {
      expiresAt: new Date(NOW.getTime() + MAXIMUM_ENVELOPE_LIFETIME_MS),
    });

    expect(verifyIdentityEnvelope(atTheLimit, [SECRET], NOW)).toMatchObject({
      outcome: "verified",
    });
  });

  it("refuses an unsigned envelope", () => {
    expect(verifyIdentityEnvelope(stripSignature(envelopeFor(SECRET)), [SECRET], NOW)).toEqual({
      outcome: "refused",
      reason: "unsigned",
    });
  });

  it("refuses one signed with a secret that is not live", () => {
    expect(verifyIdentityEnvelope(envelopeFor(OTHER_SECRET), [SECRET], NOW)).toEqual({
      outcome: "refused",
      reason: "unknown_secret",
    });
  });

  it("refuses everything when no secret has been issued", () => {
    expect(verifyIdentityEnvelope(envelopeFor(SECRET), [], NOW)).toEqual({
      outcome: "refused",
      reason: "unknown_secret",
    });
  });

  it.each([
    ["empty", ""],
    ["not three parts", "v1.only-two"],
    ["an unknown contract version", envelopeFor(SECRET).replace(/^v1\./, "v9.")],
    ["an empty payload", `${CURRENT_CONTRACT_VERSION}..signature`],
  ])("refuses %s as malformed", (_what, envelope) => {
    expect(verifyIdentityEnvelope(envelope, [SECRET], NOW)).toEqual({
      outcome: "refused",
      reason: "malformed",
    });
  });

  it("refuses a signature made over the payload alone", () => {
    // The version prefix is **inside** the signed material. Without it, an
    // envelope minted for one contract version could be replayed against
    // another the day a second one exists — and the reason a version exists at
    // all is that the two may mean different things.
    const [version, payload] = envelopeFor(SECRET).split(".") as [string, string];
    const overPayloadOnly = createHmac("sha256", SECRET).update(payload).digest("base64url");

    expect(
      verifyIdentityEnvelope(`${version}.${payload}.${overPayloadOnly}`, [SECRET], NOW),
    ).toEqual({ outcome: "refused", reason: "unknown_secret" });
  });

  it("refuses a correctly signed payload that is not an account number", () => {
    // Signed and yet unreadable is the Bank's backend having a bug rather than
    // an attacker, and there is still nothing here to act on.
    const payload = Buffer.from(JSON.stringify({ account: "12", exp: 4_000_000_000 })).toString(
      "base64url",
    );
    const material = `${CURRENT_CONTRACT_VERSION}.${payload}`;
    const signature = createHmac("sha256", SECRET).update(material).digest("base64url");

    expect(verifyIdentityEnvelope(`${material}.${signature}`, [SECRET], NOW)).toEqual({
      outcome: "refused",
      reason: "malformed",
    });
  });
});

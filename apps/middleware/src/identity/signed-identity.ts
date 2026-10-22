import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The **signed identity envelope** — the whole of what in-app chat trusts, and
 * one of the two things frozen forever by
 * [ADR-0011](../../../../docs/adr/0011-the-snippet-is-a-loader-not-the-widget.md).
 *
 * The Snippet runs on a Customer's handset inside an application we do not
 * build, so whatever it sends, the handset's owner can change. That is not a
 * flaw in the Bank's app; it is what client-side code is. And a forged account
 * number is not a small prize here — **reads are silent**, taking no Transaction
 * PIN and building no Mandate, so a Channel that trusted the number it was
 * handed would return any Customer's balance and full transaction history to
 * anyone who edited one field
 * ([ADR-0010](../../../../docs/adr/0010-the-in-app-chat-snippet-carries-a-signed-identity.md)).
 *
 * So the Bank's own backend signs it and **the Middleware verifies it**. The
 * signing secret never enters the Platform, which is the prompt-injection
 * surface ([ADR-0006](../../../../docs/adr/0006-secrets-and-security-records-live-outside-the-platform.md));
 * the Platform forwards an opaque string it never parses.
 *
 * ## The wire format
 *
 * ```
 *   <version>.<payload>.<signature>
 *
 *   payload    base64url of {"account":"<10 digits>","exp":<unix seconds>}
 *   signature  base64url of HMAC-SHA256(secret, "<version>.<payload>")
 * ```
 *
 * **One opaque string rather than three fields**, and that shape is load-bearing
 * rather than tidy: the Platform couriers it without parsing it, so there is no
 * code path in the injection surface that reads an account number out of an
 * in-app message. It is also what makes this five lines on the Bank's side —
 * ADR-0010's estimate — rather than a request shape they have to get right.
 *
 * The version prefix is inside the signed material. Without it, an envelope
 * minted for one contract version could be replayed against another the day a
 * second one exists, and the whole reason a version exists is that the two may
 * mean different things.
 */

/**
 * The loader-to-server contract versions this Middleware can mint and verify.
 *
 * **Served alongside, never edited.** A Snippet already pasted into a shipped
 * mobile application cannot be recalled or force-upgraded, so a change to this
 * contract is a new entry here and a new Widget path on the Platform — never an
 * edit to an existing one. `tests/in-app-chat.test.ts` holds the Platform to
 * serving exactly this list.
 */
export const CONTRACT_VERSIONS = ["v1"] as const;

export type ContractVersion = (typeof CONTRACT_VERSIONS)[number];

/** The version a Snippet generated today is pinned to. */
export const CURRENT_CONTRACT_VERSION: ContractVersion = "v1";

const isContractVersion = (value: string): value is ContractVersion =>
  (CONTRACT_VERSIONS as readonly string[]).includes(value);

/**
 * Why an envelope was not accepted.
 *
 * Told to the audit table and to the operational log, and **never to the
 * Platform or the Customer** — the Bank's mobile engineer needs to tell a wrong
 * secret from a clock skew, and neither of the other two has any use for it.
 */
export type IdentityRefusal =
  | "malformed"
  | "unsigned"
  | "unknown_secret"
  | "expired"
  | "lives_too_long";

/**
 * The longest an envelope may claim to be good for.
 *
 * An envelope is a **bearer credential for reading somebody's money**: whoever
 * holds it can open a conversation on that account until it expires. The Bank's
 * backend chooses the expiry, so without a ceiling here one line of their code
 * — `exp: now + a year` — quietly turns a short-lived handle into a permanent
 * key, and nothing on our side would ever say so.
 *
 * A ceiling rather than a fixed lifetime, because how short is the Bank's call
 * to make and only how *long* is ours. Twelve hours is well above any honest
 * app session and far below the point at which a leaked envelope stops
 * mattering.
 */
export const MAXIMUM_ENVELOPE_LIFETIME_MS = 12 * 60 * 60 * 1000;

export type IdentityVerification =
  | { readonly outcome: "verified"; readonly accountNumber: string }
  | { readonly outcome: "refused"; readonly reason: IdentityRefusal };

const NUBAN = /^[0-9]{10}$/;

/** The signed half of an envelope: everything up to the final separator. */
const signedMaterial = (version: string, payload: string): string => `${version}.${payload}`;

const sign = (secret: string, material: string): Buffer =>
  createHmac("sha256", secret).update(material, "utf8").digest();

/**
 * Builds an envelope the way the Bank's backend does.
 *
 * Exported because the Bank's five lines are a contract we publish, and a
 * contract nobody on this side can produce is one nobody on this side can be
 * shown to have got wrong. `packages/fakes` stands in for the Bank's backend and
 * writes its own implementation of this format rather than calling here, so the
 * two disagreeing is a test failure rather than a production incident.
 */
export const signIdentityEnvelope = (
  secret: string,
  identity: { readonly accountNumber: string; readonly expiresAt: Date },
  version: ContractVersion = CURRENT_CONTRACT_VERSION,
): string => {
  const payload = Buffer.from(
    JSON.stringify({
      account: identity.accountNumber,
      exp: Math.floor(identity.expiresAt.getTime() / 1000),
    }),
    "utf8",
  ).toString("base64url");

  const signature = sign(secret, signedMaterial(version, payload)).toString("base64url");
  return `${version}.${payload}.${signature}`;
};

/**
 * Verifies an envelope against every live signing secret and answers the account
 * it names, or why it was refused.
 *
 * **The signature is checked before the payload is read**, so nothing an
 * attacker wrote reaches a decision. Trying every live secret is what gives the
 * Bank a rotation window: issuing a second secret does not break the one their
 * backend is still signing with, and retiring the first is a separate deliberate
 * act.
 *
 * @param secrets Every **live** signing secret, in any order.
 */
export const verifyIdentityEnvelope = (
  envelope: string,
  secrets: readonly string[],
  now: Date,
): IdentityVerification => {
  const parts = envelope.split(".");
  if (parts.length !== 3) return refused("malformed");

  const [version, payload, signature] = parts as [string, string, string];
  if (!isContractVersion(version) || payload.length === 0) return refused("malformed");
  // An envelope with the signature field emptied is the shape a handset produces
  // when somebody strips it, and it is a distinct thing to record from one whose
  // signature simply does not verify.
  if (signature.length === 0) return refused("unsigned");

  const offered = Buffer.from(signature, "base64url");
  const material = signedMaterial(version, payload);
  // Every secret is tried even after one matches. A loop that returned early
  // would take measurably longer for a secret late in the list, which over
  // enough attempts says which secret signed an envelope.
  const matched = secrets.reduce((found, secret) => {
    const expected = sign(secret, material);
    const agrees = offered.length === expected.length && timingSafeEqual(offered, expected);
    return agrees || found;
  }, false);
  if (!matched) return refused("unknown_secret");

  const identity = readPayload(payload);
  // Signed and yet unreadable: the Bank's backend has a bug, not an attacker.
  // Recorded as malformed either way, because there is nothing here to act on.
  if (!identity) return refused("malformed");

  // Seconds rather than milliseconds, and `<=` rather than `<`: an envelope
  // expiring exactly now has expired.
  const expiresAt = identity.exp * 1000;
  if (expiresAt <= now.getTime()) return refused("expired");

  // Refused rather than silently clamped. Clamping would let the Bank ship a
  // year-long expiry and never find out, and the whole value of the ceiling is
  // that overshooting it is visible.
  if (expiresAt - now.getTime() > MAXIMUM_ENVELOPE_LIFETIME_MS) return refused("lives_too_long");

  return { outcome: "verified", accountNumber: identity.account };
};

const refused = (reason: IdentityRefusal): IdentityVerification => ({
  outcome: "refused",
  reason,
});

const readPayload = (payload: string): { account: string; exp: number } | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null) return undefined;
  const { account, exp } = parsed as { account?: unknown; exp?: unknown };

  if (typeof account !== "string" || !NUBAN.test(account)) return undefined;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return undefined;

  return { account, exp };
};

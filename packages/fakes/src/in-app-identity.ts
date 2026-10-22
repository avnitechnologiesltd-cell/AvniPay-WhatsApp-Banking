import { createHmac } from "node:crypto";

/**
 * The Bank's backend, signing an in-app chat identity.
 *
 * ADR-0010 puts roughly five lines on the Bank's side: take the account number
 * of the Customer already signed in to their application, take an expiry, and
 * HMAC the pair with the secret the Dashboard issued. This is those five lines,
 * **written independently of the Middleware's verifier** rather than by calling
 * it.
 *
 * That independence is the point of it living here. A round trip through one
 * implementation proves only that it agrees with itself; a second
 * implementation of a published format is the only thing that catches the two
 * drifting apart — and this format is a contract with somebody else's engineers
 * that we have committed never to break.
 *
 * ```
 *   <version>.<payload>.<signature>
 *
 *   payload    base64url of {"account":"<10 digits>","exp":<unix seconds>}
 *   signature  base64url of HMAC-SHA256(secret, "<version>.<payload>")
 * ```
 */

export interface SignedIdentityOptions {
  readonly accountNumber: string;
  /** When the envelope stops being accepted. */
  readonly expiresAt: Date;
  /** The loader-to-server contract version. Defaults to the only one there is. */
  readonly version?: string;
}

export const signInAppIdentity = (
  secret: string,
  options: SignedIdentityOptions,
): string => {
  const version = options.version ?? "v1";
  const payload = Buffer.from(
    JSON.stringify({
      account: options.accountNumber,
      exp: Math.floor(options.expiresAt.getTime() / 1000),
    }),
  ).toString("base64url");

  const signature = createHmac("sha256", secret)
    .update(`${version}.${payload}`)
    .digest("base64url");

  return `${version}.${payload}.${signature}`;
};

/**
 * Rewrites the account number inside an envelope and leaves the signature
 * alone — a handset owner editing one field, which is the attack the whole
 * design exists to refuse.
 */
export const tamperWithAccountNumber = (envelope: string, accountNumber: string): string => {
  const [version, payload, signature] = envelope.split(".") as [string, string, string];
  const claim = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
    account: string;
    exp: number;
  };

  const edited = Buffer.from(JSON.stringify({ ...claim, account: accountNumber })).toString(
    "base64url",
  );
  return `${version}.${edited}.${signature}`;
};

/** An envelope with its signature stripped, which is what "unsigned" looks like. */
export const stripSignature = (envelope: string): string => {
  const [version, payload] = envelope.split(".") as [string, string];
  return `${version}.${payload}.`;
};

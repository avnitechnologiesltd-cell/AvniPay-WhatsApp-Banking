import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * `X-Hub-Signature-256`, verified against the **raw** body.
 *
 * Two details are load-bearing:
 *
 * - **The raw bytes, not the parsed object.** Re-serialising JSON before
 *   hashing changes key order and whitespace, and the signature stops matching
 *   for reasons that look like a Meta outage. The Middleware asks Nest for
 *   `rawBody` precisely so this can be done properly.
 * - **A constant-time comparison.** A byte-by-byte early return turns the
 *   check into a timing oracle for forging a signature, one byte at a time.
 */

const PREFIX = "sha256=";

export const signBody = (rawBody: Buffer | string, appSecret: string): string =>
  `${PREFIX}${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;

/**
 * Why a signature check failed, for the log and the audit row.
 *
 * The two are worth telling apart on the way in. **`absent` means the caller is
 * not Meta** — Meta signs every endpoint request — so it is somebody who found
 * the URL. `mismatched` means the caller signed with a different app secret
 * than the one configured, which is a misconfiguration and is what an operator
 * sees while `WHATSAPP_APP_SECRET` is still a placeholder.
 *
 * One sentence goes back to the caller either way. The distinction is ours.
 */
export type SignatureFailure = "absent" | "malformed" | "mismatched";

/**
 * `undefined` when the request may proceed.
 *
 * **An absent `appSecret` means the deployment turned this off**, and every
 * request then passes. Meta recommends the check and does not require it; the
 * prior art runs without it. What is left in front of this endpoint is the
 * Flows private key, which is real but is one secret rather than two — so the
 * Middleware says at boot that it is running this way, and the audit table
 * records each exchange that was accepted unverified. See `flowSignatureNotice`.
 */
export const signatureFailure = (
  rawBody: Buffer | string | undefined,
  header: string | undefined,
  appSecret: string | undefined,
): SignatureFailure | undefined => {
  if (appSecret === undefined) return undefined;
  if (header === undefined || header === "") return "absent";
  if (rawBody === undefined) return "malformed";
  if (!header.startsWith(PREFIX)) return "malformed";
  return isSignatureValid(rawBody, header, appSecret) ? undefined : "mismatched";
};

/**
 * What to say at boot about the state of this check — one line, always logged,
 * so that "we turned it off in March" is never something anyone has to
 * remember.
 */
export const flowSignatureNotice = (
  appSecret: string | undefined,
): { readonly verifying: boolean; readonly message: string } =>
  appSecret === undefined
    ? {
        verifying: false,
        message:
          "Flows endpoint: signature verification is OFF — WHATSAPP_APP_SECRET is not set. " +
          "Any caller that can encrypt to the Flows public key is accepted. Set it to turn " +
          "verification on.",
      }
    : { verifying: true, message: "Flows endpoint: verifying X-Hub-Signature-256." };

export const isSignatureValid = (
  rawBody: Buffer | string | undefined,
  header: string | undefined,
  appSecret: string,
): boolean => {
  if (rawBody === undefined || header === undefined) return false;
  if (!header.startsWith(PREFIX)) return false;

  const expected = Buffer.from(signBody(rawBody, appSecret), "utf8");
  const offered = Buffer.from(header, "utf8");

  // `timingSafeEqual` throws on a length mismatch, which would itself leak the
  // length. A digest is fixed-length, so anything else is simply wrong.
  if (expected.length !== offered.length) return false;
  return timingSafeEqual(expected, offered);
};

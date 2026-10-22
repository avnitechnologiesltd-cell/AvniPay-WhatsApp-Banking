import { cookies } from "next/headers";

import { whoIsSignedIn, type StaffAccount } from "./staff";

/**
 * The signed-in Officer, as far as a page is concerned.
 *
 * **The cookie carries the Middleware's session token and nothing else.** No
 * role, no display name, no expiry the Dashboard reads — every one of those is
 * asked of the Middleware per request, which is what makes revoking a session
 * immediate rather than eventual. A cookie carrying the role would be a role a
 * compromised browser could edit; a cookie carrying an expiry would be a second
 * clock disagreeing with the one that matters.
 *
 * `httpOnly` because no script on this page has any business reading it, and
 * the Dashboard renders a Customer's own narrations — words somebody who can
 * send them ₦100 chose.
 */

export const SESSION_COOKIE = "avni_session";

/** A shift, matching the Middleware's own eight hours rather than guessing. */
const EIGHT_HOURS_SECONDS = 8 * 60 * 60;

export interface SignedIn {
  readonly token: string;
  readonly account: StaffAccount;
}

/**
 * Who is looking, or `undefined`.
 *
 * A round trip to the Middleware on every page, deliberately. A session revoked
 * a second ago has to stop working now — that is the whole reason ticket 28 put
 * sessions in a table rather than in a signed cookie.
 */
export const currentSession = async (): Promise<SignedIn | undefined> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return undefined;

  const account = await whoIsSignedIn(token);
  return account ? { token, account } : undefined;
};

export const rememberSession = async (token: string): Promise<void> => {
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    // `strict`, not `lax`. Nothing outside the Dashboard has any reason to
    // navigate a member of staff into a Customer's financial records.
    sameSite: "strict",
    // **Unconditional**, rather than switched on in production. A flag that is
    // sometimes absent is a flag somebody has to check the environment to
    // reason about, and `DEPLOYMENT_ENVIRONMENT` is deliberately a label
    // nothing branches on. It costs local development nothing: browsers treat
    // `http://localhost` as a trustworthy origin and accept `Secure` cookies
    // there.
    secure: true,
    path: "/",
    maxAge: EIGHT_HOURS_SECONDS,
  });
};

export const forgetSession = async (): Promise<void> => {
  (await cookies()).delete(SESSION_COOKIE);
};

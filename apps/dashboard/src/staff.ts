import { loadDashboardConfig } from "@avni/config";

/**
 * Signing in, and reading back who is signed in.
 *
 * **The Dashboard holds no credential store and never has.** Staff accounts,
 * password hashes, sessions and MFA secrets are in the Middleware — ADR-0006
 * puts security records outside the surface that faces the world, and a staff
 * password hash on a web application with a public login page is exactly the
 * thing that rule exists to prevent. This module posts a form to the Middleware
 * and is handed a token; it cannot verify one and does not try.
 *
 * The session is re-read server-side on **every** request, which is what makes
 * revoking one immediate rather than eventual. So there is no local notion of
 * "still signed in": a page asks, and a `401` is the answer.
 */

export type Role = "support_officer" | "administrator";

export interface StaffAccount {
  readonly id: string;
  readonly email: string;
  /** What a Customer is told when this Officer takes over a conversation. */
  readonly displayName: string;
  readonly role: Role;
  readonly mfaEnrolled: boolean;
  readonly disabled: boolean;
}

export type SignInResult =
  | { readonly outcome: "signed_in"; readonly token: string; readonly account: StaffAccount }
  /**
   * MFA is required for the role and the code was absent or wrong.
   *
   * `enrolled: false` is the harder case and the reason this is not just
   * *"wrong code"*: an Administrator who has never enrolled **cannot sign in at
   * all**, and letting them through just this once is how a requirement becomes
   * optional. They are enrolled by the setup step, at a terminal.
   */
  | { readonly outcome: "mfa_required"; readonly enrolled: boolean }
  | { readonly outcome: "refused" };

export interface SignInDetails {
  readonly email: string;
  readonly password: string;
  readonly totpCode?: string;
  /** Injectable so a test can point this at a Middleware it started. */
  readonly middlewareBaseUrl?: string;
}

export const signIn = async (details: SignInDetails): Promise<SignInResult> => {
  const response = await fetch(`${baseUrl(details.middlewareBaseUrl)}/dashboard/sign-in`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      email: details.email,
      password: details.password,
      ...(details.totpCode ? { totpCode: details.totpCode } : {}),
    }),
    signal: AbortSignal.timeout(20_000),
  });

  // **One refusal for every reason.** An unknown email, a wrong password and a
  // malformed form are the same sentence, and the Middleware pays the full
  // argon2id cost on all three so the timing does not say otherwise either.
  if (response.status === 401) return { outcome: "refused" };
  if (!response.ok) throw new Error(`The Middleware declined the sign-in: HTTP ${response.status}`);

  const body = (await response.json()) as {
    token?: string;
    account?: StaffAccount;
    mfaRequired?: boolean;
    enrolled?: boolean;
  };

  if (body.mfaRequired === true) {
    return { outcome: "mfa_required", enrolled: body.enrolled === true };
  }
  if (!body.token || !body.account) return { outcome: "refused" };

  return { outcome: "signed_in", token: body.token, account: body.account };
};

/**
 * Who is holding this token, or `undefined`.
 *
 * The one call every page behind the boundary makes first. It is a **server**
 * round trip rather than a decoded cookie, deliberately: a session that was
 * revoked a second ago must stop working now, and a token this Dashboard could
 * read for itself would be a token it could keep believing in.
 */
export const whoIsSignedIn = async (
  token: string,
  middlewareBaseUrl?: string,
): Promise<StaffAccount | undefined> => {
  const response = await fetch(`${baseUrl(middlewareBaseUrl)}/dashboard/me`, {
    headers: { accept: "application/json", authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20_000),
  });

  if (response.status === 401) return undefined;
  if (!response.ok) throw new Error(`The Middleware declined the session read: HTTP ${response.status}`);

  return (await response.json()) as StaffAccount;
};

/**
 * Enrolling a second factor, for somebody who cannot sign in without one.
 *
 * **Unauthenticated, and it has to be.** An Administrator who has not enrolled
 * cannot sign in at all, so there is no session to do this from — and everybody
 * after the first Administrator is created from the Dashboard rather than at the
 * server. Without this, the Officer accounts screen creates Administrators who
 * can never get in.
 *
 * The password is the whole of the check. The Middleware refuses an account that
 * is **already** enrolled, which is the case where a password alone would be
 * replacing a factor rather than adding one.
 */
export type EnrolmentOffer =
  | { readonly outcome: "offered"; readonly secret: string; readonly uri: string }
  | { readonly outcome: "refused" };

export const beginEnrolment = async (
  details: { email: string; password: string; middlewareBaseUrl?: string },
): Promise<EnrolmentOffer> => {
  const response = await fetch(
    `${baseUrl(details.middlewareBaseUrl)}/dashboard/mfa/enrolment`,
    {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ email: details.email, password: details.password }),
      signal: AbortSignal.timeout(20_000),
    },
  );

  if (response.status === 401) return { outcome: "refused" };
  if (!response.ok) throw new Error(`The Middleware declined the enrolment: HTTP ${response.status}`);

  const body = (await response.json()) as { secret?: string; uri?: string };
  if (!body.secret || !body.uri) return { outcome: "refused" };
  return { outcome: "offered", secret: body.secret, uri: body.uri };
};

export const confirmEnrolment = async (details: {
  email: string;
  password: string;
  totpCode: string;
  middlewareBaseUrl?: string;
}): Promise<{ outcome: "enrolled" } | { outcome: "refused" }> => {
  const response = await fetch(
    `${baseUrl(details.middlewareBaseUrl)}/dashboard/mfa/enrolment/confirm`,
    {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        email: details.email,
        password: details.password,
        totpCode: details.totpCode,
      }),
      signal: AbortSignal.timeout(20_000),
    },
  );

  if (response.status === 401) return { outcome: "refused" };
  if (!response.ok) throw new Error(`The Middleware declined the enrolment: HTTP ${response.status}`);

  return { outcome: "enrolled" };
};

/**
 * Ends the session in the Middleware's table.
 *
 * @returns whether the Middleware confirmed it. **`false` is not nothing**: the
 * token is still live until it expires, and the caller has to decide what to do
 * about a browser it can no longer sign out. Swallowing that would make this
 * function's whole reason for existing — that dropping the cookie alone leaves
 * a live token behind — a claim rather than a fact.
 */
export const signOut = async (token: string, middlewareBaseUrl?: string): Promise<boolean> => {
  const response = await fetch(`${baseUrl(middlewareBaseUrl)}/dashboard/sign-out`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20_000),
  }).catch(() => undefined);

  return response?.ok === true;
};

const baseUrl = (override?: string): string =>
  (override ?? loadDashboardConfig().middlewareBaseUrl).replace(/\/+$/, "");

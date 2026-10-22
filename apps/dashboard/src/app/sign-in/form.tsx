"use client";

import { useActionState } from "react";
import type { ReactNode } from "react";

import { button, field, muted, notice } from "../ui";
import { submitSignIn } from "./actions";

/**
 * The only client component on the surface, and only because a failed sign-in
 * has to say something without losing what was typed.
 *
 * The TOTP field is always shown rather than appearing on a second step. MFA is
 * **required** for an Administrator, so hiding the field until the Middleware
 * asks for it would mean every Administrator signs in twice, every time.
 */
export const SignInForm = (): ReactNode => {
  const [problem, act, pending] = useActionState(submitSignIn, undefined);

  return (
    <form action={act}>
      {problem === undefined ? null : (
        <p style={notice} role="alert">
          {problem}
        </p>
      )}

      <label>
        Email
        <input style={field} name="email" type="email" autoComplete="username" required />
      </label>

      <label>
        Password
        <input
          style={field}
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
      </label>

      <label>
        Authentication code
        <input
          style={field}
          name="totpCode"
          inputMode="numeric"
          autoComplete="one-time-code"
          // Optional for a Support Officer, required for an Administrator, and
          // the Middleware is what decides which. A `required` here would be
          // this page deciding instead.
          placeholder="Required for an Administrator"
        />
      </label>

      <p style={muted}>
        <button style={button} type="submit" disabled={pending}>
          {pending ? "Signing in…" : "Sign in"}
        </button>
      </p>
    </form>
  );
};

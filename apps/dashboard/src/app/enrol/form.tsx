"use client";

import Link from "next/link";
import { useActionState } from "react";
import type { ReactNode } from "react";

import { button, card, field, muted, notice } from "../ui";
import { enrol, type EnrolmentState } from "./actions";

/**
 * Enrolling an authenticator, in two steps on one page.
 *
 * A client component for the same reason the sign-in form is one: the secret and
 * which step the person is on have to survive a failed code without a round trip
 * that would put either in a URL.
 *
 * **The password is typed twice**, once per step, and that is deliberate. The
 * secret is staged on the account row rather than carried through the browser,
 * so the only thing this page keeps between the steps is an email address — a
 * password in a hidden field would be a credential sitting in rendered HTML for
 * whatever reads the back-forward cache.
 */
export const EnrolmentForm = (): ReactNode => {
  const [state, act, pending] = useActionState<EnrolmentState, FormData>(enrol, { step: "start" });

  if (state.step === "done") {
    return (
      <>
        <p style={muted}>
          Enrolled. Sign in with your password and a code from the authenticator.
        </p>
        <p>
          <Link href="/sign-in">Go to sign in</Link>
        </p>
      </>
    );
  }

  return (
    <form action={act}>
      {state.problem === undefined ? null : (
        <p style={notice} role="alert">
          {state.problem}
        </p>
      )}

      {state.step === "confirm" ? (
        <>
          <div style={card}>
            <p style={{ margin: "0 0 0.5rem" }}>
              Scan this in an authenticator app, or type the secret in by hand.
            </p>
            {/* The URI in full, because there is no QR code on this page and
                nothing here loads an image from anywhere to make one. */}
            <p style={{ ...muted, wordBreak: "break-all", fontFamily: "monospace" }}>{state.uri}</p>
            <p style={{ margin: 0, fontFamily: "monospace" }}>secret: {state.secret}</p>
          </div>

          <input type="hidden" name="email" value={state.email} />
        </>
      ) : (
        <label>
          Email
          <input style={field} name="email" type="email" autoComplete="username" required />
        </label>
      )}

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

      {state.step === "confirm" ? (
        <label>
          Code from the authenticator
          <input
            style={field}
            name="totpCode"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
          />
        </label>
      ) : null}

      <p style={muted}>
        <button style={button} type="submit" disabled={pending}>
          {pending ? "Working…" : state.step === "confirm" ? "Confirm" : "Continue"}
        </button>
      </p>
    </form>
  );
};

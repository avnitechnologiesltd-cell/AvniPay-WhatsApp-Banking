"use server";

import { redirect } from "next/navigation";

import { rememberSession } from "../../session";
import { signIn } from "../../staff";

/**
 * The sign-in form, submitted.
 *
 * **Nothing about the credential happens here.** The Dashboard posts the form
 * to the Middleware, which owns the password hash, the TOTP secret and the
 * session table (ADR-0006), and gets back a token or a refusal. This function's
 * whole job is to put the token in a cookie and send the Officer somewhere.
 *
 * The three refusals stay three sentences and no more: *unknown email* and
 * *wrong password* are already indistinguishable by the time they arrive here,
 * and an account with no second factor is sent to enrol one rather than told to
 * find an operator with a terminal.
 */
export const submitSignIn = async (
  _previous: string | undefined,
  form: FormData,
): Promise<string | undefined> => {
  const result = await signIn({
    email: String(form.get("email") ?? ""),
    password: String(form.get("password") ?? ""),
    totpCode: String(form.get("totpCode") ?? "").trim(),
  });

  switch (result.outcome) {
    case "signed_in":
      await rememberSession(result.token);
      break;

    case "mfa_required":
      return result.enrolled
        ? "That authentication code was not accepted."
        : "This account has no second factor yet and cannot sign in. Enrol one at /enrol, with this same password.";

    case "refused":
      return "Those details were not accepted.";
  }

  // Outside the `switch`, because `redirect` throws to unwind and would be
  // caught by anything wrapping the call above.
  redirect("/customers");
};

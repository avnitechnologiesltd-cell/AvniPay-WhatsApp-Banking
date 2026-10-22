"use server";

import { beginEnrolment, confirmEnrolment } from "../../staff";

/**
 * The two steps of enrolling a second factor.
 *
 * Both take the password, and the second one takes it again rather than
 * carrying the first one across in a hidden field. That is the point of the
 * secret being **staged on the account row** instead of round-tripping through
 * the browser: the only thing this page has to keep between the two steps is an
 * email address, so a password never sits in rendered HTML waiting for whatever
 * reads the back-forward cache.
 */

export type EnrolmentState =
  | { readonly step: "start"; readonly problem?: string }
  | {
      readonly step: "confirm";
      readonly email: string;
      readonly secret: string;
      readonly uri: string;
      readonly problem?: string;
    }
  | { readonly step: "done" };

/** One sentence for every refusal, exactly as the sign-in form has. */
const NOT_ACCEPTED =
  "Those details were not accepted, or this account already has a second factor.";

/**
 * One action for both steps, dispatching on where the form got to.
 *
 * A single `useActionState` on the client, so the secret and the step live in
 * one place rather than in two states that can disagree about which form the
 * person is looking at.
 */
export const enrol = async (
  previous: EnrolmentState,
  form: FormData,
): Promise<EnrolmentState> =>
  previous.step === "confirm" ? confirmSecret(previous, form) : offerSecret(previous, form);

const offerSecret = async (
  _previous: EnrolmentState,
  form: FormData,
): Promise<EnrolmentState> => {
  const email = String(form.get("email") ?? "").trim();
  const offered = await beginEnrolment({
    email,
    password: String(form.get("password") ?? ""),
  });

  if (offered.outcome === "refused") return { step: "start", problem: NOT_ACCEPTED };
  return { step: "confirm", email, secret: offered.secret, uri: offered.uri };
};

const confirmSecret = async (
  previous: EnrolmentState,
  form: FormData,
): Promise<EnrolmentState> => {
  const email = String(form.get("email") ?? "").trim();
  const done = await confirmEnrolment({
    email,
    password: String(form.get("password") ?? ""),
    totpCode: String(form.get("totpCode") ?? "").trim(),
  });

  if (done.outcome === "enrolled") return { step: "done" };

  // Staying on the confirm step keeps the secret on the screen, which is what
  // somebody who mistyped the code needs. It is the same secret either way —
  // it is staged on the row, not minted per attempt.
  return previous.step === "confirm"
    ? { ...previous, problem: "That code was not accepted. Try the next one." }
    : { step: "start", problem: NOT_ACCEPTED };
};

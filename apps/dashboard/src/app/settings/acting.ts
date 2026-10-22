import { redirect } from "next/navigation";

import { MiddlewareRefused } from "../../middleware-client";
import { currentSession, type SignedIn } from "../../session";

/**
 * What every write on the Settings surface does around the actual write.
 *
 * Deliberately **not** a `"use server"` file: it is imported by the two action
 * files rather than being actions itself, which is what lets it export a plain
 * helper. Both were the same fifteen lines with two different sentences in them.
 *
 * **The Dashboard grants nothing here.** Each write posts to the Middleware,
 * which checks the capability, records the attempt and refuses a Support
 * Officer — so the worst an Officer who reaches one of these can do is leave a
 * refusal row with their name on it. That is why the screen can render the
 * forms for both roles and only hide them for tidiness.
 */

export const signedIn = async (): Promise<SignedIn> => {
  const session = await currentSession();
  if (!session) redirect("/sign-in");
  return session;
};

export interface Landing {
  /** Where to go when it worked. */
  readonly saved: string;
  /** Where to go when it did not, given the sentence to show. */
  readonly refused: (problem: string) => string;
  /** What a `403` says. The two surfaces phrase it differently. */
  readonly forbidden: string;
}

/**
 * Runs one write and turns a refusal into a sentence.
 *
 * A refusal comes back as a sentence rather than a status because the sentences
 * are worth reading: *"must close after it opens"* tells an Administrator which
 * box to fix, and *"HTTP 400"* sends them to us.
 *
 * `redirect` throws a control-flow error that Next catches, so it is called
 * **outside** the try — swallowing it in the catch would turn every successful
 * save into a silent no-op.
 */
export const writing = async (
  what: () => Promise<unknown>,
  landing: Landing,
): Promise<never> => {
  let problem: string | undefined;
  let signedOut = false;

  try {
    await what();
  } catch (error) {
    if (!(error instanceof MiddlewareRefused)) throw error;
    if (error.status === 401) signedOut = true;
    else if (error.status === 403) problem = landing.forbidden;
    else problem = error.problem ?? error.message;
  }

  if (signedOut) redirect("/sign-in");
  redirect(problem ? landing.refused(problem) : landing.saved);
};

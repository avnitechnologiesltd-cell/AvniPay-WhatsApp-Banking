"use server";

import { redirect } from "next/navigation";

import { currentSession, forgetSession } from "../session";
import { signOut } from "../staff";

/**
 * Signing out, and it is **not** just dropping the cookie.
 *
 * The session lives in the Middleware's table, so the Middleware is told to end
 * it. A Dashboard that only forgot its own cookie would leave a live token
 * behind — which is precisely the thing ticket 28 moved sessions out of memory
 * to prevent.
 *
 * **The cookie is dropped either way**, and the order matters: the Middleware is
 * asked first, and if it cannot be reached the browser is still signed out. A
 * member of staff walking away from a shared machine must not be left signed in
 * because a service was down; what survives is the token's own eight hours,
 * which is the same exposure as a browser that was simply closed, and it is
 * recorded here so that nobody reads this as the token having been killed.
 */
export const endSession = async (): Promise<void> => {
  const session = await currentSession();
  const ended = session ? await signOut(session.token) : true;
  await forgetSession();

  if (!ended) {
    console.warn(
      JSON.stringify({
        service: "dashboard",
        event: "sign_out_not_confirmed",
        message:
          "The browser was signed out but the Middleware did not confirm the session was ended. It stands until it expires.",
      }),
    );
  }

  redirect("/sign-in");
};

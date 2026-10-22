import { redirect } from "next/navigation";

import { MiddlewareRefused } from "../customers";

/**
 * Runs a page's reads, and sends the Officer back to sign in if the Middleware
 * says their session is gone.
 *
 * **The gap this closes is a real one and not a race.** A page checks who is
 * signed in, then reads; between those two calls an Administrator can revoke the
 * session — which is the whole point of sessions being server-side and
 * revocable. Without this, that Officer gets a Next error page instead of the
 * sign-in screen, and the Bank's answer to *"I revoked their access"* becomes
 * *"and they saw a stack trace"*.
 *
 * A `403` is deliberately **not** handled here. Nothing on the Customers surface
 * is Administrator-only, so a role refusal there would mean the role table and
 * the routes had gone out of step — and turning that into a redirect would hide
 * it. It surfaces as an error, which is what it is.
 */
export const readingAsOfficer = async <T>(read: () => Promise<T>): Promise<T> => {
  try {
    return await read();
  } catch (error) {
    if (error instanceof MiddlewareRefused && error.status === 401) redirect("/sign-in");
    throw error;
  }
};

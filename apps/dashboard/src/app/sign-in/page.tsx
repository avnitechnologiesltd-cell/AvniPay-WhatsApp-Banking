import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { currentSession } from "../../session";
import { heading, muted, page } from "../ui";
import { SignInForm } from "./form";

/**
 * The way a human gets into the Dashboard.
 *
 * **No account exists on a fresh deployment.** The first Administrator is made
 * by an explicit setup step at a terminal — `docker compose run --rm
 * setup-administrator` — and never on first boot, which is the mistake the
 * prior art made and the reason this page has no "create an account" link.
 */
const SignInPage = async (): Promise<ReactNode> => {
  if (await currentSession()) redirect("/customers");

  return (
    <main style={{ ...page, maxWidth: "24rem" }}>
      <h1 style={heading}>Avni Dashboard</h1>
      <p style={muted}>Banking administration and support for the Bank&rsquo;s staff.</p>
      <SignInForm />
      {/* Not a "create an account" link, and the wording says so. Nothing at
          the other end makes an account — it adds a second factor to one that
          already has a password, which is the state every Administrator
          invited from the Officers screen starts in. */}
      <p style={muted}>
        <Link href="/enrol">Enrol an authenticator</Link> — for an account with a password but no
        second factor yet.
      </p>
    </main>
  );
};

export default SignInPage;

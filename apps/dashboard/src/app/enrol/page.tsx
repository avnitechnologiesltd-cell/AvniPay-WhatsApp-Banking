import Link from "next/link";
import type { ReactNode } from "react";

import { heading, muted, page } from "../ui";
import { EnrolmentForm } from "./form";

/**
 * Where somebody who cannot sign in yet enrols a second factor.
 *
 * **This page exists because MFA is required for an Administrator and everybody
 * after the first is created from the Dashboard.** The setup step makes exactly
 * one account and declines once any exists, so without this an Administrator
 * invited from the Officers screen could never sign in — and the setup step's own
 * failure message already tells an operator to *"enrol it from the Dashboard"*.
 *
 * It is deliberately not a "create an account" link. Nothing here makes an
 * account, and an email and password that do not already belong to one are
 * refused in the same sentence as an account that is already enrolled.
 */
const EnrolPage = async (): Promise<ReactNode> => (
  <main style={{ ...page, maxWidth: "28rem" }}>
    <h1 style={heading}>Enrol an authenticator</h1>
    <p style={muted}>
      For an account that has a password but no second factor yet. An Administrator cannot sign in
      without one.
    </p>
    <EnrolmentForm />
    <p style={muted}>
      <Link href="/sign-in">Back to sign in</Link>
    </p>
  </main>
);

export default EnrolPage;

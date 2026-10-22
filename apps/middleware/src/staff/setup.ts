import type { Pool } from "@avni/db";

import { AuditRepository } from "../audit/audit.repository";
import { passwordProblem } from "./passwords";
import { StaffRepository } from "./staff.repository";
import { generateTotpSecret, totpEnrolmentUri, verifyTotp } from "./totp";

/**
 * Creating the **first Administrator**, as a function rather than a script.
 *
 * The prompts and the terminal live in `setup-cli.ts`; everything that decides
 * anything is here, so it can be tested without a pseudo-terminal. A step this
 * security-relevant should not be verified by feeding a heredoc into `docker
 * compose run` and hoping.
 */

export interface SetupPrompts {
  /** Asks a question and returns the answer. */
  readonly ask: (question: string) => Promise<string>;
  readonly say: (line: string) => void;
  /** Injectable so a test can supply a code it can compute. */
  readonly now?: () => number;
  /** Injectable so a test knows the secret it must produce a code for. */
  readonly newSecret?: () => string;
  /**
   * The Bank's own name, so the entry in somebody's authenticator says who it
   * is for — the same `BANK_NAME` the Dashboard's enrolment uses.
   */
  readonly issuer: string;
}

export type SetupOutcome =
  | { readonly outcome: "created"; readonly accountId: string; readonly email: string }
  /** An account already exists. Nobody after the first is made here. */
  | { readonly outcome: "declined"; readonly existing: number }
  | { readonly outcome: "refused"; readonly problem: string }
  /**
   * The account was made and MFA was not enrolled, so it cannot sign in.
   * Distinct from `refused` because the operator has to do something different
   * about it.
   */
  | { readonly outcome: "created_without_mfa"; readonly accountId: string };

export const runSetup = async (
  pool: Pool,
  prompts: SetupPrompts,
): Promise<SetupOutcome> => {
  const staff = new StaffRepository(pool);
  const now = prompts.now ?? (() => Date.now());
  const newSecret = prompts.newSecret ?? generateTotpSecret;

  const existing = await staff.countAccounts();
  if (existing > 0) {
    prompts.say(
      `setup: this deployment already has ${existing} staff account(s). ` +
        "Invite the next one from the Dashboard rather than here.",
    );
    return { outcome: "declined", existing };
  }

  prompts.say("Creating the first Administrator. This runs once.\n");

  const email = (await prompts.ask("Email: ")).trim();
  const displayName = (await prompts.ask("Display name (a Customer sees this): ")).trim();
  const password = await prompts.ask("Password (at least 12 characters): ");

  const problem =
    (email.includes("@") ? undefined : "that email does not look like an email") ??
    (displayName.length > 0 ? undefined : "a display name is required") ??
    (passwordProblem(password) === undefined
      ? undefined
      : `the password ${passwordProblem(password)}`);

  if (problem) {
    prompts.say(`\nsetup: refused — ${problem}.`);
    return { outcome: "refused", problem };
  }

  const account = await staff.createAccount({
    email,
    displayName,
    password,
    role: "administrator",
  });

  // MFA is required for this role, so it is enrolled here rather than leaving
  // an Administrator who cannot sign in.
  const secret = newSecret();
  prompts.say("\nScan this in an authenticator app, or type the secret in by hand:\n");
  prompts.say(`  ${totpEnrolmentUri(secret, email, prompts.issuer)}`);
  prompts.say(`  secret: ${secret}\n`);

  const code = (await prompts.ask("Enter the six-digit code to confirm: ")).trim();
  if (!verifyTotp(secret, code, now())) {
    prompts.say(
      "\nsetup: that code did not verify. The account exists but MFA is not enrolled, so it\n" +
        "       cannot sign in. Enrol it from the Dashboard, or drop the row and run this again.",
    );
    return { outcome: "created_without_mfa", accountId: account.id };
  }

  await staff.enrolMfa(account.id, secret);
  await new AuditRepository(pool).record({
    action: "staff.account_created",
    actor: { kind: "system" },
    outcome: "succeeded",
    detail: { accountId: account.id, role: "administrator", by: "the setup step" },
  });

  prompts.say(`\nsetup: created ${email} as an Administrator, with MFA enrolled.`);
  return { outcome: "created", accountId: account.id, email };
};

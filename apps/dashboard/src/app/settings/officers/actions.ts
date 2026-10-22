"use server";

import {
  createOfficer,
  resetOfficerPassword,
  revokeOfficerSessions,
  updateOfficer,
} from "../../../settings";
import type { Role } from "../../../staff";
import { signedIn, writing, type Landing } from "../acting";

/**
 * Who may sign in, and **what a Customer is told they are called**.
 *
 * The display name is the part with a consequence outside this screen: a
 * Customer handed to a human is told that human's name in both directions, so a
 * Bank that cannot change it is a Bank whose Customers are told something wrong.
 *
 * Every one of these is Administrator-only, checked in the Middleware. A Support
 * Officer who posted one by hand would leave a refusal row with their name on it
 * and change nothing.
 */

const LANDING: Landing = {
  saved: "/settings/officers?saved=yes",
  refused: (problem) => `/settings/officers?problem=${encodeURIComponent(problem)}`,
  forbidden: "Only an Administrator may do that.",
};

export const invite = async (form: FormData): Promise<void> => {
  const session = await signedIn();

  await writing(
    () =>
      createOfficer(session, {
        email: String(form.get("email") ?? "").trim(),
        displayName: String(form.get("displayName") ?? "").trim(),
        password: String(form.get("password") ?? ""),
        role: roleFrom(form.get("role")),
      }),
    LANDING,
  );
};

export const rename = async (form: FormData): Promise<void> => {
  const session = await signedIn();

  await writing(
    () =>
      updateOfficer(session, String(form.get("officerId") ?? ""), {
        displayName: String(form.get("displayName") ?? "").trim(),
      }),
    LANDING,
  );
};

export const changeRole = async (form: FormData): Promise<void> => {
  const session = await signedIn();

  await writing(
    () =>
      updateOfficer(session, String(form.get("officerId") ?? ""), {
        role: roleFrom(form.get("role")),
      }),
    LANDING,
  );
};

/**
 * Disabling kills every session that account holds, in the same act.
 *
 * Leaving one would make *"their access is off"* true of the sign-in page and
 * false of every page behind it until the eight hours ran out.
 */
export const setAccess = async (form: FormData): Promise<void> => {
  const session = await signedIn();

  await writing(
    () =>
      updateOfficer(session, String(form.get("officerId") ?? ""), {
        disabled: form.get("disabled") === "true",
      }),
    LANDING,
  );
};

export const resetPassword = async (form: FormData): Promise<void> => {
  const session = await signedIn();

  await writing(
    () =>
      resetOfficerPassword(
        session,
        String(form.get("officerId") ?? ""),
        String(form.get("password") ?? ""),
      ),
    LANDING,
  );
};

export const signOutEverywhere = async (form: FormData): Promise<void> => {
  const session = await signedIn();

  await writing(
    () => revokeOfficerSessions(session, String(form.get("officerId") ?? "")),
    LANDING,
  );
};

/**
 * Anything that is not the Administrator role is read as the lesser one.
 *
 * The safe direction, deliberately: a mangled form field must not be able to
 * make somebody an Administrator, and the Middleware refuses a role it does not
 * recognise anyway.
 */
const roleFrom = (value: FormDataEntryValue | null): Role =>
  value === "administrator" ? "administrator" : "support_officer";

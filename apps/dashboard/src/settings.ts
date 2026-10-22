import { ask, type Session } from "./middleware-client";
import type { Role, StaffAccount } from "./staff";

/**
 * The Settings surface: **the configuration a bank changes on its own
 * schedule, without asking a vendor.**
 *
 * Four things live here, and they are grouped by who may write them rather than
 * by what they look like. A Support Officer reads all of it and writes none of
 * it; an Administrator writes all of it. That line is not an abstraction the
 * Dashboard invented — the Middleware holds it, checks it per capability, and
 * records the refusal when somebody crosses it. This module cannot grant
 * anything, which is why it is safe for it to render both.
 *
 * The tariff is the one that matters most, and the reason this is a screen
 * rather than deploy-time configuration: **a fee change alters what a Customer
 * is charged**, and a bank changes its fees under its own regulator.
 */

// --- The tariff ---------------------------------------------------------------

/** One line of a published tariff: *"up to ₦5,000: ₦10"*. `null` means *and above*. */
export interface TariffBand {
  readonly upTo: number | null;
  readonly fee: number;
}

export interface Tariff {
  readonly intraBank: readonly TariffBand[];
  readonly interBank: readonly TariffBand[];
  /** A percentage, charged on the fee and never on the amount being sent. */
  readonly vatRate: number;
}

export const readTariff = async (session: Session): Promise<Tariff | null> => {
  const body = await ask<{ tariff: Tariff | null }>(session, "/dashboard/tariff", "the tariff read");
  return body.tariff;
};

/**
 * Sets the Bank's tariff, or **withdraws it** with `null`.
 *
 * Withdrawing is a real act rather than a gap in the form: a Bank whose fees are
 * under review has to be able to go back to the honest sentence, and the
 * Confirmation screen says *"fees apply per your account tariff"* the moment
 * they do.
 */
export const writeTariff = async (session: Session, tariff: Tariff | null): Promise<void> => {
  await ask(session, "/dashboard/tariff", "a tariff change", {
    method: "PUT",
    body: { tariff },
  });
};

// --- Business hours and the operations alert address --------------------------

export interface OpeningHours {
  readonly opens: string;
  readonly closes: string;
}

/** A day is either a window or `null`, and `null` means closed. */
export type BusinessDays = Readonly<Record<Weekday, OpeningHours | null>>;

export const WEEKDAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

export type Weekday = (typeof WEEKDAYS)[number];

/** The names the hours form's inputs carry, so the page and the action agree. */
export const dayField = (day: Weekday, part: "opens" | "closes"): string => `${day}.${part}`;

export interface BusinessHours {
  readonly timeZone: string;
  readonly days: BusinessDays;
}

export interface PlatformSettings {
  /** `null` until the Bank sets them. There is deliberately no default. */
  readonly businessHours: BusinessHours | null;
  readonly operationsAlertAddress: string;
}

export const readSettings = (session: Session): Promise<PlatformSettings> =>
  ask(session, "/dashboard/settings", "the settings read");

export const writeSetting = async (
  session: Session,
  key: "business_hours" | "operations_alert_address",
  value: unknown,
): Promise<void> => {
  await ask(session, "/dashboard/settings", `a change to ${key}`, {
    method: "PUT",
    body: { key, value },
  });
};

// --- Officer accounts ----------------------------------------------------------

export const listOfficers = async (session: Session): Promise<readonly StaffAccount[]> => {
  const body = await ask<{ officers?: readonly StaffAccount[] }>(
    session,
    "/dashboard/officers",
    "the Officer list",
  );
  return body.officers ?? [];
};

export interface NewOfficer {
  readonly email: string;
  /** **What the Customer is told on a Handoff**, in both directions. */
  readonly displayName: string;
  readonly password: string;
  readonly role: Role;
}

export const createOfficer = (session: Session, officer: NewOfficer): Promise<StaffAccount> =>
  ask(session, "/dashboard/officers", "a new Officer account", {
    method: "POST",
    body: officer,
  });

export interface OfficerChanges {
  readonly displayName?: string;
  readonly role?: Role;
  readonly disabled?: boolean;
}

export const updateOfficer = (
  session: Session,
  officerId: string,
  changes: OfficerChanges,
): Promise<StaffAccount> =>
  ask(session, `/dashboard/officers/${encodeURIComponent(officerId)}`, "an Officer account change", {
    method: "PUT",
    body: changes,
  });

/** A reset rather than a change: **every session that account held is killed.** */
export const resetOfficerPassword = (
  session: Session,
  officerId: string,
  password: string,
): Promise<{ reset: true; sessionsEnded: number }> =>
  ask(
    session,
    `/dashboard/officers/${encodeURIComponent(officerId)}/password`,
    "a password reset",
    { method: "POST", body: { password } },
  );

/**
 * One session an account is holding, as an Administrator is shown it.
 *
 * Enough to recognise a session and nothing that could be used to become one —
 * no token, and no hash of one.
 */
export interface LiveSession {
  readonly id: string;
  readonly startedAt: string;
  readonly lastSeenAt: string;
  readonly expiresAt: string;
  readonly userAgent: string | null;
  readonly ipAddress: string | null;
}

export const listOfficerSessions = async (
  session: Session,
  officerId: string,
): Promise<readonly LiveSession[]> => {
  const body = await ask<{ sessions?: readonly LiveSession[] }>(
    session,
    `/dashboard/officers/${encodeURIComponent(officerId)}/sessions`,
    "an Officer's sessions",
  );
  return body.sessions ?? [];
};

/** A stolen laptop, or a leaver. Their access ends now rather than in eight hours. */
export const revokeOfficerSessions = (
  session: Session,
  officerId: string,
): Promise<{ sessionsEnded: number }> =>
  ask(
    session,
    `/dashboard/officers/${encodeURIComponent(officerId)}/sessions/revoke`,
    "a sign-out",
    { method: "POST" },
  );

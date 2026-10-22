"use server";

import { redirect } from "next/navigation";

import { WEEKDAYS, dayField, writeSetting, writeTariff, type BusinessDays } from "../../settings";
import { readTariffForm } from "../../tariff-form";
import { signedIn, writing, type Landing } from "./acting";

/**
 * Everything an Administrator changes on the Settings screen.
 *
 * The shared parts — resolving the session, and turning a refusal into a
 * sentence the screen can show — are in `acting.ts`, which the Officers actions
 * use too.
 */

const LANDING: Landing = {
  saved: "/settings?saved=yes",
  refused: (problem) => `/settings?problem=${encodeURIComponent(problem)}`,
  forbidden: "Your role does not allow that.",
};

export const saveTariff = async (form: FormData): Promise<void> => {
  const session = await signedIn();

  const read = readTariffForm((name) => String(form.get(name) ?? ""));
  if (read.outcome === "refused") redirect(LANDING.refused(read.problem));

  await writing(() => writeTariff(session, read.tariff), LANDING);
};

/**
 * Takes the Bank's tariff away, and the Confirmation screen goes back to
 * saying *"fees apply per your account tariff"*.
 *
 * A separate action from saving one, because it is a separate decision. A Bank
 * whose fees are under review should not have to empty every box and hope the
 * result means nothing.
 */
export const withdrawTariff = async (): Promise<void> => {
  const session = await signedIn();
  await writing(() => writeTariff(session, null), LANDING);
};

export const saveBusinessHours = async (form: FormData): Promise<void> => {
  const session = await signedIn();

  const days = Object.fromEntries(
    WEEKDAYS.map((day) => {
      const opens = String(form.get(dayField(day, "opens")) ?? "").trim();
      const closes = String(form.get(dayField(day, "closes")) ?? "").trim();

      // **Both blank means shut**, and it is the only way to say shut. A day
      // with one time filled in is a mistake rather than a half-open day, and
      // the Middleware says which field.
      return [day, opens === "" && closes === "" ? null : { opens, closes }];
    }),
  ) as BusinessDays;

  await writing(
    () =>
      writeSetting(session, "business_hours", {
        timeZone: String(form.get("timeZone") ?? "").trim(),
        days,
      }),
    LANDING,
  );
};

export const saveAlertAddress = async (form: FormData): Promise<void> => {
  const session = await signedIn();

  await writing(
    () =>
      writeSetting(
        session,
        "operations_alert_address",
        String(form.get("operationsAlertAddress") ?? "").trim(),
      ),
    LANDING,
  );
};

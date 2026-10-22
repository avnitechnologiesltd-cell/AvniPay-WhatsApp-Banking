import { z } from "zod";

/**
 * The Bank's real opening hours, and the sentence a Customer is told out of
 * them.
 *
 * **The prior art hardcoded `"Business hours: Mon–Fri, 8am–6pm WAT"` into a
 * message string**, which means the out-of-hours problem was already visible to
 * whoever wrote it and their answer was to print it at the Customer. It is
 * configuration here for the obvious reason — a bank that opens on Saturday
 * should not need a redeploy — and for the less obvious one: the same value
 * decides whether a Handoff queues, so a hardcoded string would have been a
 * behavioural constant wearing a sentence's clothes.
 *
 * Everything in this file is pure. Whether the Bank is open is arithmetic over a
 * setting and an instant, and it is tested as arithmetic rather than through an
 * HTTP endpoint that happened to be called at the right time of day.
 */

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

/** `HH:mm`, 24-hour. Refused at anything else rather than coerced. */
const timeOfDay = z
  .string()
  .trim()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "must be a time of day as HH:mm");

const openingHours = z
  .object({ opens: timeOfDay, closes: timeOfDay })
  .strict()
  .refine(
    (day) => minutesOf(day.opens) < minutesOf(day.closes),
    "must close after it opens — an overnight shift is not a banking day",
  );

/**
 * A day is either a window or `null`, and `null` means closed.
 *
 * Deliberately not an omitted key: a Bank that forgot to list Saturday and a
 * Bank that is shut on Saturday are the same state, and making them the same
 * value removes the question of which one an absent key meant.
 */
export const businessHoursSchema = z
  .object({
    /**
     * An IANA zone. Nigeria has no daylight saving, but the platform must not
     * assume that on the Bank's behalf — `Africa/Lagos` is a fact about the
     * Bank, and `UTC+1` would be a fact we invented that stops being true if
     * anything ever changes.
     */
    timeZone: z.string().trim().min(1),
    days: z.object(
      Object.fromEntries(WEEKDAYS.map((day) => [day, openingHours.nullable()])) as Record<
        Weekday,
        z.ZodNullable<typeof openingHours>
      >,
    ),
  })
  .strict()
  .refine(
    (hours) => isKnownTimeZone(hours.timeZone),
    "must be an IANA time zone the runtime recognises, such as Africa/Lagos",
  );

export type BusinessHours = z.infer<typeof businessHoursSchema>;

const isKnownTimeZone = (timeZone: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone });
    return true;
  } catch {
    return false;
  }
};

const minutesOf = (time: string): number => {
  const [hours = "0", minutes = "0"] = time.split(":");
  return Number(hours) * 60 + Number(minutes);
};

/**
 * Whether the Bank is open at `now`, in the Bank's own zone.
 *
 * Read through `Intl` rather than by adding an offset, because an offset is a
 * number somebody has to keep correct and a zone is a name the runtime keeps
 * correct. The container runs in UTC and the Bank does not.
 */
export const isOpenAt = (hours: BusinessHours, now: Date): boolean => {
  const local = localised(hours.timeZone, now);
  const day = hours.days[local.weekday];
  if (!day) return false;

  return local.minutes >= minutesOf(day.opens) && local.minutes < minutesOf(day.closes);
};

const localised = (timeZone: string, now: Date): { weekday: Weekday; minutes: number } => {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);

  const read = (type: string): string =>
    parts.find((part) => part.type === type)?.value ?? "";

  return {
    weekday: read("weekday").toLowerCase() as Weekday,
    // `24` rather than `00` is a real `Intl` answer for midnight under
    // `hour12: false` in some runtimes, and it would otherwise put the whole of
    // the first hour of a day after every closing time.
    minutes: (Number(read("hour")) % 24) * 60 + Number(read("minute")),
  };
};

/**
 * The Bank's hours as a Customer is told them — *"Monday to Friday, 8am to
 * 6pm"*.
 *
 * Consecutive days with identical hours are collapsed into a range, because
 * seven lines in a WhatsApp message is not an answer to *"when can somebody
 * help me"*. It is composed here, in the Middleware, for the one reason the
 * Middleware ever composes a Customer sentence: it holds the setting, and
 * shipping the raw hours to the Platform would put a fragment of the Bank's
 * configuration inside the prompt-injection surface for no gain.
 */
export const hoursInWords = (hours: BusinessHours): string => {
  const open = WEEKDAYS.map((day) => ({ day, window: hours.days[day] }));
  const runs: { from: Weekday; to: Weekday; opens: string; closes: string }[] = [];

  for (const { day, window } of open) {
    if (!window) continue;
    const last = runs[runs.length - 1];
    const contiguous =
      last !== undefined &&
      last.opens === window.opens &&
      last.closes === window.closes &&
      WEEKDAYS.indexOf(day) === WEEKDAYS.indexOf(last.to) + 1;

    if (contiguous && last) last.to = day;
    else runs.push({ from: day, to: day, opens: window.opens, closes: window.closes });
  }

  if (runs.length === 0) return "";

  return runs
    .map((run) => {
      const days =
        run.from === run.to
          ? capitalise(run.from)
          : `${capitalise(run.from)} to ${capitalise(run.to)}`;
      return `${days}, ${clockWords(run.opens)} to ${clockWords(run.closes)}`;
    })
    .join("; ");
};

const capitalise = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

/** `08:00` becomes `8am`, `18:30` becomes `6.30pm`. How a person says a time. */
const clockWords = (time: string): string => {
  const [rawHours = "0", rawMinutes = "00"] = time.split(":");
  const hours = Number(rawHours);
  const suffix = hours < 12 ? "am" : "pm";
  const twelve = hours % 12 === 0 ? 12 : hours % 12;

  return rawMinutes === "00" ? `${twelve}${suffix}` : `${twelve}.${rawMinutes}${suffix}`;
};

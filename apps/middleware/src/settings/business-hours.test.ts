import { describe, expect, it } from "vitest";

import { businessHoursSchema, hoursInWords, isOpenAt, type BusinessHours } from "./business-hours";

/**
 * The Bank's hours, and the sentence a Customer is told out of them.
 *
 * The prior art hardcoded *"Business hours: Mon–Fri, 8am–6pm WAT"* into a
 * message string — which means whoever wrote it had already seen the
 * out-of-hours problem, and printed it at the Customer. These tests are the
 * other answer: the hours are a value, whether the Bank is open is arithmetic
 * over that value, and the sentence is rendered from it.
 */

const LAGOS = "Africa/Lagos";

const weekdaysOnly = (opens = "08:00", closes = "18:00"): BusinessHours => ({
  timeZone: LAGOS,
  days: {
    monday: { opens, closes },
    tuesday: { opens, closes },
    wednesday: { opens, closes },
    thursday: { opens, closes },
    friday: { opens, closes },
    saturday: null,
    sunday: null,
  },
});

describe("whether the Bank is open", () => {
  it("answers in the Bank's own zone and not the container's", () => {
    // The container runs in UTC and Lagos is an hour ahead. 07:30 UTC on a
    // Wednesday is 08:30 in Lagos, which is open — and reading the raw UTC
    // hour would call it shut.
    expect(isOpenAt(weekdaysOnly(), new Date("2026-08-19T07:30:00Z"))).toBe(true);
  });

  it("is shut before opening and after closing", () => {
    // 06:00 UTC is 07:00 in Lagos; 17:30 UTC is 18:30.
    expect(isOpenAt(weekdaysOnly(), new Date("2026-08-19T06:00:00Z"))).toBe(false);
    expect(isOpenAt(weekdaysOnly(), new Date("2026-08-19T17:30:00Z"))).toBe(false);
  });

  it("is open at the opening minute and shut at the closing one", () => {
    // Half-open, and deliberately: a Bank that closes at 18:00 is not taking a
    // conversation at 18:00.
    expect(isOpenAt(weekdaysOnly(), new Date("2026-08-19T07:00:00Z"))).toBe(true);
    expect(isOpenAt(weekdaysOnly(), new Date("2026-08-19T17:00:00Z"))).toBe(false);
  });

  it("is shut on a day the Bank listed as closed", () => {
    // 2026-08-22 is a Saturday.
    expect(isOpenAt(weekdaysOnly(), new Date("2026-08-22T10:00:00Z"))).toBe(false);
  });

  it("is open on a Saturday for a Bank that opens on one", () => {
    const saturdays: BusinessHours = {
      ...weekdaysOnly(),
      days: { ...weekdaysOnly().days, saturday: { opens: "09:00", closes: "13:00" } },
    };

    expect(isOpenAt(saturdays, new Date("2026-08-22T09:00:00Z"))).toBe(true);
    expect(isOpenAt(saturdays, new Date("2026-08-22T13:00:00Z"))).toBe(false);
  });

  it("treats midnight as the start of the day rather than the end of it", () => {
    // `Intl` answers `24` for midnight under `hour12: false` in some runtimes,
    // which would put the whole first hour of a day after every closing time.
    const allNight: BusinessHours = {
      ...weekdaysOnly(),
      days: { ...weekdaysOnly().days, wednesday: { opens: "00:00", closes: "23:59" } },
    };

    // 23:30 UTC Tuesday is 00:30 Wednesday in Lagos.
    expect(isOpenAt(allNight, new Date("2026-08-18T23:30:00Z"))).toBe(true);
  });
});

describe("the hours as a Customer is told them", () => {
  it("collapses consecutive days with the same hours into a range", () => {
    // Seven lines is not an answer to "when can somebody help me".
    expect(hoursInWords(weekdaysOnly())).toBe("Monday to Friday, 8am to 6pm");
  });

  it("keeps a day with different hours separate", () => {
    const withSaturday: BusinessHours = {
      ...weekdaysOnly(),
      days: { ...weekdaysOnly().days, saturday: { opens: "09:00", closes: "13:00" } },
    };

    expect(hoursInWords(withSaturday)).toBe(
      "Monday to Friday, 8am to 6pm; Saturday, 9am to 1pm",
    );
  });

  it("names a single open day without inventing a range", () => {
    const fridayOnly: BusinessHours = {
      timeZone: LAGOS,
      days: { ...weekdaysOnly().days, monday: null, tuesday: null, wednesday: null, thursday: null },
    };

    expect(hoursInWords(fridayOnly)).toBe("Friday, 8am to 6pm");
  });

  it("says the minutes when there are any", () => {
    expect(hoursInWords(weekdaysOnly("08:30", "17:45"))).toBe(
      "Monday to Friday, 8.30am to 5.45pm",
    );
  });

  it("says noon and midnight the way a person does", () => {
    expect(hoursInWords(weekdaysOnly("00:00", "12:00"))).toBe(
      "Monday to Friday, 12am to 12pm",
    );
  });

  it("says nothing at all for a Bank that is never open", () => {
    const never: BusinessHours = {
      timeZone: LAGOS,
      days: {
        monday: null,
        tuesday: null,
        wednesday: null,
        thursday: null,
        friday: null,
        saturday: null,
        sunday: null,
      },
    };

    // Empty rather than "never" — the caller renders no hours instead of
    // telling a Customer the Bank does not open.
    expect(hoursInWords(never)).toBe("");
  });
});

describe("what the Bank may configure", () => {
  it("refuses a time that is not a time of day", () => {
    expect(businessHoursSchema.safeParse(weekdaysOnly("8am", "18:00")).success).toBe(false);
    expect(businessHoursSchema.safeParse(weekdaysOnly("25:00", "26:00")).success).toBe(false);
  });

  it("refuses a day that closes before it opens", () => {
    // An overnight shift is not a banking day, and treating one as a window
    // would make `isOpenAt` silently false for every minute of it.
    expect(businessHoursSchema.safeParse(weekdaysOnly("18:00", "08:00")).success).toBe(false);
  });

  it("refuses a time zone the runtime does not recognise", () => {
    expect(
      businessHoursSchema.safeParse({ ...weekdaysOnly(), timeZone: "Africa/Lagoss" }).success,
    ).toBe(false);
  });

  it("refuses hours that omit a day rather than closing it", () => {
    // A Bank that forgot Saturday and a Bank that is shut on Saturday must be
    // the same value, so that an absent key cannot mean either.
    const { saturday, ...rest } = weekdaysOnly().days;
    void saturday;

    expect(businessHoursSchema.safeParse({ timeZone: LAGOS, days: rest }).success).toBe(false);
  });

  it("accepts the shape the Bank actually has", () => {
    expect(businessHoursSchema.safeParse(weekdaysOnly()).success).toBe(true);
  });
});

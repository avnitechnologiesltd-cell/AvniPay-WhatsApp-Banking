/**
 * A clock a test can move.
 *
 * The rules it exists for are hours and months long — a 1-hour lockout, a
 * 10-minute code, a 90-day dormancy window — and they are *behaviour*, not
 * timing details. Without this a test either sleeps for an hour or asserts
 * nothing, and it is always the second.
 *
 * Structurally a `Clock` from `@avni/service`, without the dependency: the
 * interface is one method, and a fixture reaching into the runtime package to
 * borrow it would be the wrong direction of arrow.
 */
export interface TestClock {
  readonly now: () => Date;
  /**
   * Waiting, under test, is moving time forward and carrying on.
   *
   * So an inline TSQ poll that waits three seconds between queries runs through
   * its whole twenty-second bound in the time it takes to make the queries — and
   * the mandate expiry it is racing moves with it, rather than standing still
   * while the poll pretends to wait.
   */
  readonly sleep: (milliseconds: number) => Promise<void>;
  /** Moves time forward. Negative is refused — nothing under test goes back. */
  readonly advance: (milliseconds: number) => void;
  readonly set: (moment: Date) => void;
}

export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;

/**
 * Starts at a fixed instant rather than at `Date.now()`, so a failure is
 * reproducible and never depends on the hour the suite happened to run in.
 */
export const createTestClock = (start = new Date("2026-08-21T09:00:00.000Z")): TestClock => {
  let current = start.getTime();

  const advance = (milliseconds: number): void => {
    if (milliseconds < 0) throw new Error("A clock under test does not go backwards.");
    current += milliseconds;
  };

  return {
    now: () => new Date(current),
    sleep: (milliseconds) => {
      advance(milliseconds);
      return Promise.resolve();
    },
    advance,
    set: (moment) => {
      current = moment.getTime();
    },
  };
};

/**
 * The one production seam this workspace adds for testing, and it is added
 * deliberately.
 *
 * Four rules in this platform are *behaviour* rather than timing details — a
 * Mandate expires at 3 hours, a PIN lockout lasts 1 hour, an enrollment code
 * lasts 10 minutes, and a Binding goes dormant after 90 days. A test that
 * cannot move time either sleeps for an hour or asserts nothing, and the second
 * is what actually happens. So the clock is injected.
 *
 * **It is not a general "now" service.** Everything that merely stamps a row
 * keeps using Postgres's `now()`, which is one fewer thing to get wrong and one
 * fewer clock to disagree with. This exists for the places where the *passage*
 * of time changes an answer.
 */
export interface Clock {
  readonly now: () => Date;
  /**
   * Waits, in whatever way this clock understands waiting.
   *
   * Here for the **inline TSQ poll**: the Middleware answers a transfer in the
   * same turn the Customer authorised it, which means waiting three seconds at
   * a time inside a request. That schedule is behaviour — how long a Customer
   * is left before they are told it is being followed up — and a suite that
   * cannot move through it either waits twenty real seconds per transfer or
   * asserts nothing about the bound.
   */
  readonly sleep: (milliseconds: number) => Promise<void>;
}

export const systemClock: Clock = {
  now: () => new Date(),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

/** Injection token, so nothing resolves a clock from a parameter's type. */
export const CLOCK = Symbol("CLOCK");

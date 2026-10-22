/**
 * The CBN check digit, computed here rather than asked of the Bank.
 *
 * This is the finding that makes enumeration resistance survivable. An account
 * number the Bank does not hold walks a *silent* path — a destination screen, a
 * code screen, and the same failure wording as a wrong code — because anything
 * else is an oracle. That is the right behaviour for a probe and a cruel one for
 * a Customer who mistyped a digit: without a local check they wait for a code
 * that was never sent, fail three times, and are locked out for an hour with no
 * message that would have helped.
 *
 * A 10-digit NUBAN is nine serial digits plus a check digit over
 * `<3-digit bank code> + <9 serial digits>`, so most single-digit typos are
 * catchable in one screen with no call leaving the platform. That is the whole
 * job of this file.
 *
 * **Confirm the weight vector against the CBN circular before go-live.** It is
 * reproduced from the enrollment prototype, which validated it against both
 * BankOne reference account numbers, and those are two data points rather than a
 * specification.
 */

/**
 * `3 7 3` repeating, over the twelve digits of bank code plus serial. Fixed
 * length, which is why the bank code is validated as three digits at the
 * configuration boundary rather than here.
 */
const WEIGHTS = [3, 7, 3, 3, 7, 3, 3, 7, 3, 3, 7, 3] as const;

const TEN_DIGITS = /^\d{10}$/;

/** The check digit a serial should carry, under this bank's CBN code. */
export const nubanCheckDigit = (nubanBankCode: string, serial: string): number => {
  const digits = `${nubanBankCode}${serial}`.split("").map(Number);
  const sum = digits.reduce((total, digit, index) => total + digit * (WEIGHTS[index] ?? 0), 0);
  return (10 - (sum % 10)) % 10;
};

/**
 * Whether `accountNumber` could be an account at this bank.
 *
 * **True does not mean the account exists** — it means the number is not
 * obviously mistyped, and nothing more. What exists is the Bank's to say, and it
 * says so through an API this check exists to keep honest typos away from.
 */
export const isWellFormedNuban = (nubanBankCode: string, accountNumber: string): boolean => {
  if (!TEN_DIGITS.test(accountNumber)) return false;

  return nubanCheckDigit(nubanBankCode, accountNumber.slice(0, 9)) === Number(accountNumber[9]);
};

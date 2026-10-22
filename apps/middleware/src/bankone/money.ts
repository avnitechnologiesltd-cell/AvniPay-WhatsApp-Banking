/**
 * BankOne money values, read safely.
 *
 * Two rules, both absolute, both belonging to the adapter and never to a
 * caller ([`bankone-api.md`](../../../../docs/reference/bankone-api.md)
 * Appendix A.2):
 *
 * - **Strip thousands separators before parsing.** `parseFloat("1,000,000.00")`
 *   is `1`. This fails only above ₦1,000, so it passes every small-value test.
 * - **Amounts are naira, not kobo.** Never divide by 100.
 *
 * And one consequence: **no raw BankOne money string leaves this module.**
 * Everything upward is a number that has already been through here.
 */

/** A naira decimal, optionally grouped, optionally signed, nothing else. */
const READABLE = /^-?\d+(\.\d+)?$/;

export class UnreadableAmountError extends Error {
  public override readonly name = "UnreadableAmountError";

  public constructor(public readonly value: unknown) {
    super(
      `BankOne returned an amount this adapter cannot read: ${JSON.stringify(value)}. ` +
        "Refusing rather than guessing — a wrong balance is worse than no balance.",
    );
  }
}

/**
 * Reads a BankOne money value as naira.
 *
 * Throws rather than returning `0` on anything unreadable. Zero is a balance a
 * Customer can have, so using it as a failure signal would tell somebody they
 * have nothing on the strength of a parse error.
 */
export const parseBankOneAmount = (value: unknown): number => {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new UnreadableAmountError(value);
    return value;
  }

  if (typeof value !== "string") throw new UnreadableAmountError(value);

  const cleaned = value
    .trim()
    .replace(/^₦/, "")
    .replace(/,/g, "")
    .trim();

  if (!READABLE.test(cleaned)) throw new UnreadableAmountError(value);

  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) throw new UnreadableAmountError(value);
  return parsed;
};

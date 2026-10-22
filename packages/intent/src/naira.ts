/**
 * Naira, as a Customer reads it.
 *
 * The other end of the rule the BankOne adapter enforces: the adapter strips
 * separators so a figure is never misread, and this puts them back so a figure
 * is never *mis-shown*. A Customer with ₦1,000,000 is told ₦1,000,000.
 *
 * It lives beside the Intent rather than in either deployable because **both**
 * render money to the same Customer — the Platform words a balance, and the
 * Middleware writes the amount on the Confirmation screen, which is the one
 * screen a Customer checks before their money moves. Two copies of this rule
 * would be two chances for those two figures to disagree.
 */
export const formatNaira = (naira: number): string => {
  const whole = Number.isInteger(naira);
  return `₦${naira.toLocaleString("en-NG", {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
};

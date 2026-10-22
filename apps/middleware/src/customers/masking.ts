/**
 * How a channel identity is shown to a Support Officer.
 *
 * **Masked, and the reason is the account-number search.** An Officer who
 * searches by phone number already holds the number, so masking costs them
 * nothing. An Officer who searches by *account number* does not — and an
 * unmasked Binding on that screen would turn every account number into its
 * owner's mobile number, for anybody with a Dashboard session. That is a
 * different and larger thing than *"which of your numbers is linked"*, which is
 * the question this surface actually has to answer, and the last four digits
 * answer it: a Customer on the telephone confirms them in one breath.
 *
 * The masking is the Bank's own convention from
 * [`bank-identity-api.md`](../../../../docs/reference/bank-identity-api.md) §4.1
 * — `••• ••• ` and the last four — so the Dashboard and the enrollment screens
 * do not show a Customer's number two different ways.
 */

const MASK = "••• ••• ";

export const maskChannelIdentity = (channelIdentity: string): string => {
  const digits = channelIdentity.replace(/\D+/g, "");
  // Too short to have a tail worth hiding. Masking it to nothing would be worse
  // than saying plainly that this is not a number we can show.
  if (digits.length < 4) return MASK.trimEnd();

  return `${MASK}${digits.slice(-4)}`;
};

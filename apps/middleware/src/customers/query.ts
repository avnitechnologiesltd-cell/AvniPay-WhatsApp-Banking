/**
 * What an Officer typed into the Customers search box, read into the one or two
 * things the platform can actually look up.
 *
 * **There are exactly two keys in this product**, and this file is where that
 * fact becomes visible. An account number is what every banking operation takes
 * ([`bank-identity-api.md`](../../../../docs/reference/bank-identity-api.md) §1),
 * and a channel identity is what a **Binding** is made of. There is no third,
 * and in particular **there is no search by name**: BankOne resolves an account
 * number to a name and never the reverse, and the Bank's identity API is
 * explicitly forbidden from answering with one, because account number in and
 * real name out with no verification is a free enumeration oracle.
 *
 * The rule that earns its place is the last one. `8012345678` is a well-formed
 * NUBAN *and* a Nigerian subscriber number with its trunk zero missing, and
 * nothing in ten digits distinguishes them. So this **does not choose** — it
 * returns both readings and lets the search run both lookups. Choosing would
 * mean an Officer with a real query being told there is no such Customer, which
 * is the worst answer this surface can give.
 */

/** What to look the Customer up by. Either field may be absent; both may be. */
export interface CustomerQuery {
  /** A NUBAN, exactly as typed. Ten digits or nothing. */
  readonly accountNumber?: string;
  /** A WhatsApp `wa_id`: `234` followed by the ten-digit subscriber number. */
  readonly channelIdentity?: string;
}

const NIGERIA = "234";

/**
 * The digits an operator can actually issue.
 *
 * Nigerian mobile subscriber numbers begin `7`, `8` or `9` once the trunk zero
 * is gone. Without this an account number beginning `0` would also be looked up
 * as somebody's handset — a meaningless query in front of an audited surface,
 * and a row in the audit table that says an Officer searched for a number that
 * cannot exist.
 */
const MOBILE_PREFIX = /^[789]/;

export const readCustomerQuery = (typed: string): CustomerQuery => {
  const digits = typed.replace(/\D+/g, "");

  return {
    // A NUBAN is ten digits **as typed**. `2348012345678` is not one that
    // happens to be prefixed; it is a phone number.
    ...(digits.length === 10 ? { accountNumber: digits } : {}),
    ...whatsappIdentityIn(digits),
  };
};

const whatsappIdentityIn = (digits: string): CustomerQuery => {
  const local = digits.startsWith(NIGERIA) ? digits.slice(NIGERIA.length) : digits;

  // `08012345678` and `8012345678` are the same handset, and both spellings
  // reach an Officer — one off a Customer's lips, the other off a form.
  const subscriber = local.length === 11 && local.startsWith("0") ? local.slice(1) : local;

  if (subscriber.length !== 10 || !MOBILE_PREFIX.test(subscriber)) return {};
  return { channelIdentity: `${NIGERIA}${subscriber}` };
};

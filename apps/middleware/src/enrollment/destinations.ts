import { createHmac } from "node:crypto";

/**
 * Where a one-time code can be sent, as the platform is allowed to know it.
 *
 * **The platform never learns the contact.** The Bank's service holds the phone
 * number and the email, sends the code itself, and hands back an opaque handle
 * and a masked label it chose. We render the label verbatim and quote the handle
 * back. At no point is `08037776655` a value in this system
 * ([`bank-identity-api.md`](../../../../docs/reference/bank-identity-api.md) §2,
 * [ADR-0006](../../../../docs/adr/0006-secrets-and-security-records-live-outside-the-platform.md)).
 */
export interface Destination {
  readonly id: string;
  readonly kind: "phone" | "email";
  /** Display text, chosen by the Bank. Rendered as given. */
  readonly masked: string;
}

/**
 * Decoy destinations for an account the Bank does not hold.
 *
 * Enumeration resistance means an unknown account number gets a destination
 * screen, a code screen and the identical failure wording as a wrong code. That
 * needs destinations to show, and inventing them carelessly gives back
 * everything the silence bought:
 *
 * - **Random decoys are themselves the oracle.** Two probes of the same unknown
 *   number would differ, and nothing else in the system does that. So the
 *   derivation is deterministic on the account number.
 * - **Deterministic on the account number *alone* is worse.** Anyone who has
 *   read this file could then compute the decoy list for any account offline and
 *   tell a fabricated destination screen from a real one at a glance. So it is
 *   keyed on a Middleware-side secret, and stays reproducible only to us.
 *
 * A residual leak, recorded rather than closed: the *distribution* — how many
 * phones, whether there is an email — should be sampled from the Bank's real
 * customer base. The shape below is invented, so an attacker holding a handful
 * of known-good accounts could in principle characterise the difference. Closing
 * it needs figures only the Bank has.
 */
const EMAIL_DOMAINS = ["gmail", "yahoo", "outlook", "hotmail"] as const;
const EMAIL_LOCAL_INITIALS = "abcdefghijklmnopqrstuvwxyz";

/** One byte of keyed pseudo-randomness, stable for a given label. */
const byteFor = (secret: string, accountNumber: string, label: string, offset = 0): number => {
  const digest = createHmac("sha256", secret).update(`${accountNumber}:${label}`).digest();
  return digest[offset] ?? 0;
};

const digitsFor = (secret: string, accountNumber: string, label: string, count: number): string => {
  const digest = createHmac("sha256", secret).update(`${accountNumber}:${label}`).digest();
  let value = 0;
  for (let index = 0; index < 4; index += 1) value = value * 256 + (digest[index] ?? 0);
  return String(value % 10 ** count).padStart(count, "0");
};

/**
 * The Bank's recommended masking, reproduced exactly.
 *
 * A decoy that masks differently from the real thing is a decoy that announces
 * itself, so this is not a style choice: phone is `••• ••• ` plus the last four,
 * email is the first character, the first character of the domain, and the TLD
 * ([`bank-identity-api.md`](../../../../docs/reference/bank-identity-api.md) §4.1).
 */
const maskedPhone = (lastFour: string): string => `••• ••• ${lastFour}`;
const maskedEmail = (initial: string, domainInitial: string): string =>
  `${initial}•••@${domainInitial}•••.com`;

export const decoyDestinations = (
  secret: string,
  accountNumber: string,
): readonly Destination[] => {
  const destinations: Destination[] = [];

  const phones = 1 + (byteFor(secret, accountNumber, "phone-count") % 2);
  for (let index = 0; index < phones; index += 1) {
    destinations.push({
      // Positional and opaque, exactly like the Bank's own `d1`, `d2`. An id
      // that gave the game away would undo everything the masking bought.
      id: `d${destinations.length + 1}`,
      kind: "phone",
      masked: maskedPhone(digitsFor(secret, accountNumber, `phone-${index}`, 4)),
    });
  }

  // Roughly two accounts in three carry an email.
  if (byteFor(secret, accountNumber, "has-email") % 3 !== 0) {
    const initial = EMAIL_LOCAL_INITIALS[
      byteFor(secret, accountNumber, "email-initial") % EMAIL_LOCAL_INITIALS.length
    ] as string;
    const domain = EMAIL_DOMAINS[
      byteFor(secret, accountNumber, "email-domain") % EMAIL_DOMAINS.length
    ] as string;

    destinations.push({
      id: `d${destinations.length + 1}`,
      kind: "email",
      masked: maskedEmail(initial, domain[0] as string),
    });
  }

  return destinations;
};

/**
 * One `Destination`, as a Flow's `RadioButtonsGroup` reads it.
 *
 * A published Flow binds its options to `id` and `title` and can rename
 * neither, so the Bank's masked label is presented under the name the surface
 * expects. `kind` is dropped: it decides nothing on the screen, and a Customer
 * can already see whether they are looking at a number or an address.
 */
export const asFlowOption = (destination: Destination): { id: string; title: string } => ({
  id: destination.id,
  title: destination.masked,
});

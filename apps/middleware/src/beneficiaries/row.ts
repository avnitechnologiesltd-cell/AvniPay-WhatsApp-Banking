import type { Beneficiary } from "./beneficiaries.repository";

/**
 * A Beneficiary as one row of the **Disambiguation screen**.
 *
 * It lives here rather than beside the transfer that renders it, because every
 * decision in it is about a Beneficiary: which of its two names leads, what is
 * shown beside them, and how much of an account number a Customer needs to see.
 */

/** One row, in the shape a Flow's server-fed dropdown reads. */
export interface DisambiguationRow {
  /** The record's id, returned when the Customer taps it. Scoped to its owner. */
  readonly id: string;
  readonly title: string;
  readonly description: string;
}

/**
 * The last four digits, and no more.
 *
 * Not secrecy — the Customer saved this account and could read it back off their
 * own statement. It is legibility: a whole account number on a list row is ten
 * digits nobody reads, sitting beside the two things a Customer does recognise.
 */
const mask = (accountNumber: string): string => `••••${accountNumber.slice(-4)}`;

/** What to call a Beneficiary when only one string will fit. */
export const nameOf = (beneficiary: Beneficiary): string =>
  beneficiary.label.length > 0 ? beneficiary.label : beneficiary.nameAtSave;

/**
 * **The bank's own name is on every row**, because it is the thing a Customer
 * actually recognises — a label is their own word for somebody and an account
 * number is ten digits they have never memorised.
 *
 * Where there is no label the bank's name is the title instead, which is the
 * same information on one line rather than two. A label never appears alone:
 * this screen is the one place a Customer separates two people wearing the same
 * nickname, and two rows reading *"Musa"* would not let them.
 */
export const asRow = (beneficiary: Beneficiary): DisambiguationRow => ({
  id: beneficiary.id,
  title: nameOf(beneficiary),
  description:
    beneficiary.label.length > 0
      ? `${beneficiary.nameAtSave} · ${beneficiary.bankName} ${mask(beneficiary.accountNumber)}`
      : `${beneficiary.bankName} ${mask(beneficiary.accountNumber)}`,
});

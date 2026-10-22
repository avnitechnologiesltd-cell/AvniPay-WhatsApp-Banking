import { findBank } from "../transfers/banks";
import { tidy } from "./matching";

/**
 * The **label** — the Customer's own word for somebody they paid.
 *
 * It is the one Customer-typed string the resolver later searches, and it is
 * captured **inside the sealed surface** rather than asked for in conversation.
 * That is not a convenience. A Customer replying `Musa` to *"what should I call
 * them?"* is indistinguishable from a malformed Intent to the model reading it,
 * and `actually send 2000 to Ade instead` is indistinguishable from a
 * Beneficiary with a very odd name. Managing that needs an *awaiting label*
 * state that suppresses Intent extraction for exactly one turn — a state machine
 * wrapped around an LLM to protect it from a question we asked. An optional
 * field on the Confirmation screen removes the ambiguity instead of managing it,
 * and the string never passes through the Platform or the model at all.
 *
 * What a label is **not** is proof of who holds an account. The Confirmation
 * screen shows the name enquiry result, never this
 * ([ADR-0008](../../../../docs/adr/0008-an-intent-becomes-a-mandate-when-authorised.md)).
 */

/**
 * Twenty-four characters, and the number is not arbitrary: it is where WhatsApp
 * truncates a list row title. A longer label would be silently cut at the exact
 * moment a Customer is choosing between two similar records, which is the one
 * moment the screen exists for.
 */
export const MOST_LABEL_CHARACTERS = 24;

/** What the Customer reads when a label will not do, in the words they see. */
export const LABEL_WORDS = {
  tooLong: `Please use ${MOST_LABEL_CHARACTERS} characters or fewer.`,
  allDigits: "Please use a name rather than a number.",
  namesABank: "Please use the person's name rather than a bank's.",
} as const;

/**
 * Why this label may not be saved, or nothing.
 *
 * **An empty label is not a problem.** The field is optional and a transfer is
 * never held up by one nobody filled in — the record is still findable, because
 * resolution searches the bank's own name for the account as well.
 *
 * The label is **tidied and not folded**: it is searched case-insensitively and
 * shown back verbatim, so losing the Customer's own capitalisation here would
 * cost something and buy nothing.
 *
 * @param typed What the Customer put in the "Save as" field, before tidying.
 */
export const labelProblem = (typed: string): string | undefined => {
  const label = tidy(typed);
  if (label.length === 0) return undefined;

  if (label.length > MOST_LABEL_CHARACTERS) return LABEL_WORDS.tooLong;

  // So that *"send 5000 to 2124955312"* always means the account number and
  // never somebody's nickname. Spaces are ignored, because a Customer typing an
  // account number into a name field types it the way they read it out.
  if (/^\d+$/.test(label.replace(/\s+/g, ""))) return LABEL_WORDS.allDigits;

  // A saved recipient called *"GTBank"* reads as the institution rather than as
  // a person, on the one screen whose job is saying who is about to be paid.
  // The whole label has to name a bank — *"Musa at GTBank"* is a person, and the
  // directory does not match it.
  if (findBank(label)) return LABEL_WORDS.namesABank;

  return undefined;
};

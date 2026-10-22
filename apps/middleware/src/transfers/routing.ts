import { NIGERIAN_BANKS, findBank } from "./banks";

/**
 * Intra-bank or inter-bank, decided **here and from the bank code alone**.
 *
 * The Customer never says which kind of transfer they are making and the Intent
 * carries no variant for it — splitting the two upstream would push a BankOne
 * implementation detail into the LLM's job, and would let a model's mistake
 * choose which endpoint moves the money. The Middleware decides, in two steps
 * that are worth keeping apart:
 *
 * 1. **The bank the Customer named becomes a NIBSS code** — the Bank's own from
 *    configuration, another bank's from the directory in `banks.ts`, or nothing
 *    at all.
 * 2. **The code decides the endpoint.** `isIntraBank` compares two strings and
 *    knows nothing about names, which is why the same decision comes out the
 *    same way at dispatch, hours later, from the code stored on the Mandate.
 *
 * **A bank neither step recognises is refused, not guessed at.** An unrecognised
 * name costs a Customer a sentence; routing it on a guess costs them a debit to
 * whoever holds that number at whichever bank the guess landed on.
 */

/**
 * Words that say *bank* rather than say *which* bank.
 *
 * Dropped from both sides before comparing, so "Example" and "Example MFB" and
 * "example microfinance bank" are one bank, and "Access Bank" is still not. The
 * possessives are here for the same reason: *"my bank"* names no bank, and a
 * Customer who said it meant the one they are talking to.
 */
const GENERIC = new Set([
  "bank",
  "banks",
  "mfb",
  "microfinance",
  "micro",
  "finance",
  "plc",
  "ltd",
  "limited",
  "the",
  "my",
  "our",
  "own",
  "same",
  "this",
]);

/** Lowercase words, punctuation stripped, generic banking words removed. */
const significantWords = (name: string): readonly string[] =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((word) => word.length > 0 && !GENERIC.has(word));

/**
 * Whether the bank a Customer named is this Bank.
 *
 * A **blank** name means they named none, which is read as their own bank:
 * *"send 2000 to 2124955312"* is how most Customers say it, and the model is
 * told to leave the field empty rather than invent one. The Confirmation screen
 * shows the destination bank and the name that account holds either way, so a
 * Customer who meant another bank sees it before the PIN rather than after the
 * debit.
 *
 * Otherwise it is a share of significant words. Substring matching would make
 * "Example" match "Example Trust" and prefix matching would not match "MFB
 * Example"; a word in common is the rule a person would use reading the two names
 * side by side.
 */
export const namesThisBank = (stated: string, bankName: string): boolean => {
  const said = significantWords(stated);
  if (said.length === 0) return true;

  const ours = new Set(significantWords(bankName));
  return said.some((word) => ours.has(word));
};

/** A bank the money can be sent to: a NIBSS code, and a name to show. */
export interface DestinationBank {
  readonly code: string;
  readonly name: string;
}

/**
 * The bank a Customer named, as a code — or nothing, which is a refusal.
 *
 * Two rules, and they are asked in an order that matters. This Bank is matched
 * **loosely**, because a Customer talking to their own bank says *"my bank"* or
 * half its name. Every other bank is matched **exactly**, for the reason
 * `banks.ts` gives at length: at this Bank a shared word is the same
 * institution, and across the directory it is a different one.
 *
 * **A name that satisfies both rules is refused**, rather than resolved by
 * whichever was asked first. It means the Customer named something that is both
 * this Bank and a bank in the directory — a deployment whose own name collides
 * with somebody else's — and no rule can say which they meant. Resolving it
 * either way sends an account number to an institution on a coin toss; refusing
 * makes the collision immediate and total for that name, which is a
 * configuration problem the Bank can see rather than a debit a Customer cannot
 * undo. (Where the two agree on a *code*, there is nothing to be ambiguous
 * about: the Bank is simply in the directory under its own name.)
 *
 * The name that comes back is the **bank's own**, not the Customer's spelling.
 * It is what the Confirmation screen shows, so somebody who typed a name loosely
 * sees which institution the Middleware settled on before they enter a PIN.
 */
export const resolveBank = (
  stated: string,
  ours: DestinationBank,
): DestinationBank | undefined => {
  const found = findBank(stated);
  const mine = namesThisBank(stated, ours.name);

  if (found && mine && found.code !== ours.code) return undefined;
  if (found) return { code: found.code, name: found.name };

  return mine ? ours : undefined;
};

/**
 * Which endpoint moves the money, from **the code and nothing else**.
 *
 * Two strings compared. That is the whole rule, and its plainness is the point:
 * the decision is the same when it is made against a Mandate written three hours
 * ago as when it was made against the Intent, because both times it reads the
 * same stored code rather than re-interpreting a name.
 */
export const isIntraBank = (destinationBankCode: string, ourBankCode: string): boolean =>
  destinationBankCode === ourBankCode;

// --- Whether the Bank is who its configuration says it is --------------------

/**
 * What the NIBSS list says about the code this deployment calls its own.
 *
 * `unlisted` is not an error. A list can lag a licence, and a bank absent from
 * it is a plausible bank; refusing to start on that would be the vendor's data
 * blocking the Bank's deployment.
 */
export type OwnBankCodeCheck =
  | { readonly outcome: "agrees"; readonly listedAs: string }
  | { readonly outcome: "unlisted" }
  | { readonly outcome: "mismatch"; readonly listedAs: string };

/**
 * Whether `BANK_CODE` and `BANK_NAME` describe the same institution.
 *
 * **This exists because they once did not.** `BANK_CODE` was `090110` — the
 * value the vendored API guide uses as its example — and `090110` is VFD
 * Microfinance Bank. Two things followed and neither was visible: every
 * same-bank name enquiry asked VFD who holds an account, which staging could not
 * reveal because staging's name enquiry is stubbed (Appendix A.4); and a
 * transfer a Customer meant for VFD resolved to the Bank's own code and would
 * have gone down the intra-bank endpoint, reaching whoever held that number
 * here.
 *
 * Both are silent in every environment where they can be tested. So the check
 * runs at boot, where a wrong code stops a deployment instead of a Customer's
 * money.
 *
 * The comparison is the **loose** rule, deliberately. The list says *"Example
 * Microfinance Bank"* and configuration says *"Example MFB"*, and those are one
 * institution; what this is looking for is a code whose listed name has nothing
 * to do with the Bank's at all.
 */
export const checkOwnBankCode = (ours: DestinationBank): OwnBankCodeCheck => {
  const listed = NIGERIAN_BANKS.find((bank) => bank.code === ours.code);
  if (!listed) return { outcome: "unlisted" };

  return namesThisBank(listed.name, ours.name)
    ? { outcome: "agrees", listedAs: listed.name }
    : { outcome: "mismatch", listedAs: listed.name };
};

/**
 * The Bank's own code belongs to somebody else. Nothing serves.
 *
 * Named, so `runEntryPoint` prints a sentence an operator can act on rather than
 * a stack trace — the same treatment a database that has not been migrated gets,
 * and for the same reason: it is a deployment mistake, not a defect.
 */
export class BankCodeMismatchError extends Error {
  public constructor(ours: DestinationBank, listedAs: string) {
    super(
      `BANK_CODE ${ours.code} is ${listedAs} in the NIBSS bank list, but BANK_NAME says ${ours.name}. ` +
        "Every same-bank name enquiry would be asked of that institution, and a transfer meant for it " +
        "would be sent down the intra-bank endpoint. Check BANK_CODE against the Bank's own list.",
    );
    this.name = "BankCodeMismatchError";
  }
}

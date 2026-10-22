/**
 * Turning **Musa** into a shortlist of accounts.
 *
 * This is the one step in the whole platform where a Customer's words become
 * somebody's account number by *inference* rather than by instruction, which
 * makes it the most attractive target on the money path. The defence is not in
 * here: it is that **resolving one decides what is offered, never what is
 * sent**. Every answer this module can give — none, one, several — ends at the
 * same Confirmation screen and the same Transaction PIN.
 *
 * So what this module owes is predictability rather than cleverness:
 *
 * - **Case- and space-normalised, and nothing more.** Two spellings that differ
 *   only in shouting or in whitespace are one name.
 * - **Prefix *and* substring**, which in practice is substring — a prefix is a
 *   substring that starts at nothing. Written as `includes` for that reason.
 * - **Two characters minimum.** Nigerian short forms are frequently two letters,
 *   so three would refuse *"Ib"*; one would match most of a store and hand the
 *   Customer a list that means nothing.
 * - **No typo tolerance.** It buys one avoided re-type and pays in wrong-person
 *   risk, against a Confirmation screen that should not have to carry it.
 *
 * The search runs in memory over one Customer's own records rather than in SQL.
 * A store is tens of rows, and the alternative is normalisation that has to
 * agree between TypeScript and a Postgres collation — two implementations of the
 * rule this module exists to state once.
 */

/**
 * The shortest thing that is a search rather than a shrug. Two characters, per
 * the module note above.
 */
export const MINIMUM_SEARCH = 2;

/**
 * How many rows the Disambiguation screen offers.
 *
 * **Eight, and deliberately not ten.** Ten is the ceiling a WhatsApp list
 * message imposes, and rendering this inside a Flow is what escaped it — so
 * landing back on that number would be the platform keeping a constraint it had
 * already paid to be rid of. What survives instead is a judgement: this screen
 * is a security surface rather than a convenience, it is the one place a
 * Customer separates two people wearing the same nickname, and somebody
 * scrolling a long list of near-identical rows is not choosing carefully.
 *
 * What falls off the end is still reachable — the same screen carries an
 * account-number form.
 */
export const MOST_ROWS = 8;

/** Zero-width and control characters, which a paste from a contacts app brings. */
const NON_PRINTING = /[\p{Cc}\p{Cf}]/gu;

/**
 * The one cleaning step: non-printing characters removed, runs of space
 * collapsed, trimmed — and **case left alone**.
 *
 * Everything a Customer types about a person goes through this, and it is one
 * function because a label that was stored under one set of rules and searched
 * under another would be a label that cannot be found.
 */
export const tidy = (value: string): string =>
  value.replace(NON_PRINTING, "").replace(/\s+/g, " ").trim();

/** `tidy`, and then folded — the form two names are *compared* in. */
export const normaliseName = (value: string): string => tidy(value).toLowerCase();

/**
 * The two strings a record is searched by: the Customer's own label, and the
 * **bank's own name for the account at the moment it was saved**.
 *
 * Searching the second costs nothing and catches the case a label-only store
 * misses entirely — a Customer saying a surname that was never typed into a
 * "Save as" field. It is also why a record with no label at all is still
 * findable, which matters because the label is optional and most records will
 * not have one.
 */
export interface Searchable {
  readonly label: string;
  readonly nameAtSave: string;
  /** Most-recently-used decides the order, and therefore what the cap drops. */
  readonly lastUsedAt: Date;
}

/**
 * Every saved recipient whose label or saved name contains what was said,
 * most-recently-used first and capped.
 *
 * `records` may arrive in any order; the ordering is imposed here so that the
 * cap is applied to the same list a Customer would have read.
 */
export const matchingBeneficiaries = <T extends Searchable>(
  records: readonly T[],
  said: string,
): readonly T[] => {
  const wanted = normaliseName(said);
  if (wanted.length < MINIMUM_SEARCH) return [];

  return [...records]
    .filter(
      (record) =>
        normaliseName(record.label).includes(wanted) ||
        normaliseName(record.nameAtSave).includes(wanted),
    )
    .sort((left, right) => right.lastUsedAt.getTime() - left.lastUsedAt.getTime())
    .slice(0, MOST_ROWS);
};

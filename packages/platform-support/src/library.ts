/**
 * The **Library**, as the Support Agent reaches it.
 *
 * A port with one method, and the shape of it is the design. The Library lives
 * in the Middleware — it is written by an Administrator through the Dashboard,
 * audited against a named member of staff, and stored beside the rows the
 * Dashboard writes so that unpublishing is complete the moment it commits. This
 * package holds none of that and could not: the Platform may not import the
 * Middleware at all ([ADR-0006](../../../docs/adr/0006-secrets-and-security-records-live-outside-the-platform.md)),
 * so the application wires an HTTP call in behind this function type.
 *
 * **The search takes a query and nothing else.** There is no Customer
 * identifier on it and no field to scope by, which is the structural half of
 * *"one Customer's stored conversation can never reach another Customer's
 * retrieval"*: a Library is Bank-wide and identical for every Customer, and
 * conversation history is per-Customer regulated data. One mechanism for two
 * incompatible access rules is how a cross-Customer leak gets built, and this is
 * the one mechanism.
 */

/**
 * One section of one live document, **with everything a citation needs**.
 *
 * The three attribution fields are on the section rather than composed later,
 * because the platform writes the citation itself rather than asking the model
 * to. A model that composes its own citations composes plausible ones.
 */
export interface LibrarySection {
  readonly documentTitle: string;
  /** The Bank's own heading. `''` where the text sat above the first one. */
  readonly heading: string;
  /** `YYYY-MM-DD`. The Bank's date for the policy, not the day it was uploaded. */
  readonly versionDate: string;
  readonly text: string;
}

export type LibrarySearch = (query: string) => Promise<readonly LibrarySection[]>;

/** What the Customer is shown as the source of an answer. */
export interface Citation {
  readonly documentTitle: string;
  readonly heading: string;
  readonly versionDate: string;
}

/**
 * What joins the three parts of a citation into a deduplication key.
 *
 * A unit separator, **written as an escape**. The literal character was in this
 * file once and it made the whole file binary to git — undiffable, and therefore
 * unreviewable, in every future change. An invisible byte in source is a bug
 * whether or not the code around it works.
 */
const SEPARATOR = "\u001f";

const citationOf = (section: LibrarySection): Citation => ({
  documentTitle: section.documentTitle,
  heading: section.heading,
  versionDate: section.versionDate,
});

/** The distinct places an answer came from, in the order they were retrieved. */
export const citationsFor = (sections: readonly LibrarySection[]): readonly Citation[] => {
  const seen = new Set<string>();
  const citations: Citation[] = [];

  for (const section of sections) {
    const citation = citationOf(section);
    const key = [citation.documentTitle, citation.heading, citation.versionDate].join(SEPARATOR);
    if (seen.has(key)) continue;
    seen.add(key);
    citations.push(citation);
  }
  return citations;
};

/**
 * A citation in words: **document title, section, and version date.**
 *
 * Composed here from the rows that were retrieved, and never by the model. That
 * is what makes an invented citation impossible rather than discouraged — the
 * model is told not to write one, and even if it did, this is what a Customer
 * sees underneath the answer.
 */
export const citationsInWords = (citations: readonly Citation[]): string => {
  if (citations.length === 0) return "";

  const lines = citations.map(
    (citation) =>
      `${citation.documentTitle}${citation.heading ? `, ${citation.heading}` : ""}` +
      ` (${inWords(citation.versionDate)})`,
  );

  return `${lines.length === 1 ? "Source" : "Sources"}: ${lines.join("; ")}.`;
};

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/**
 * `2026-03-01` becomes `1 March 2026`.
 *
 * A date a Customer reads rather than one a database sorts by, and it is spelt
 * out because `01/03/2026` means two different days depending on who is reading
 * it — which is not a thing to be ambiguous about in a citation.
 */
const inWords = (versionDate: string): string => {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(versionDate);
  if (!parts) return versionDate;

  const month = MONTHS[Number(parts[2]) - 1];
  return month ? `${Number(parts[3])} ${month} ${parts[1]}` : versionDate;
};

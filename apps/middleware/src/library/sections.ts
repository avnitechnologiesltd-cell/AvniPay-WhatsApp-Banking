/**
 * Cutting a document into **sections**, which is the grain everything else in
 * the Library works at.
 *
 * A heading is a boundary the Bank already drew. That is the entire argument for
 * this file existing rather than a chunk size existing: *"Funds Transfer Policy,
 * Charges, 1 March 2026"* is a citation a Support Officer can check against the
 * document on their desk, and *"chunk 14 of 60"* is not — so the retrieval grain
 * and the citation grain have to be the same thing, and the Bank's own headings
 * are the only candidate that is both.
 *
 * Nothing here is a guess about meaning. It recognises the four ways a heading
 * is written down and takes everything between two of them as one section.
 */

/**
 * Tokens per character, near enough.
 *
 * Four characters to a token is the ordinary English figure and this is an
 * **estimate on purpose**. It exists to keep the retrieved payload inside a
 * capacity ceiling — Groq's 250K TPM, which a corpus in the preamble multiplies
 * against every turn of every conversation — and a budget with a configurable
 * default does not need an exact count, it needs one that cannot drift far and
 * costs nothing to compute. Counting properly would mean a tokenizer for a model
 * we do not host, on the ingestion path, for a number that is compared against a
 * value somebody typed.
 */
export const estimateTokens = (text: string): number => Math.max(1, Math.ceil(text.length / 4));

/**
 * The largest a single section may be before it is split again at a paragraph.
 *
 * Not a quality knob either. A document with no headings at all — which is what
 * a scanned policy retyped into one file looks like — would otherwise be one
 * section larger than the entire per-turn budget, and a section that cannot fit
 * the budget is a section that is never retrieved. The Bank's document would be
 * published, live, and silently unreachable.
 *
 * The split keeps the heading, so both halves cite the same place.
 */
const MAX_SECTION_TOKENS = 700;

export interface Section {
  readonly ordinal: number;
  /** '' where the document opened with text before its first heading. */
  readonly heading: string;
  readonly body: string;
  readonly tokenEstimate: number;
}

/** Markdown's own, and the only unambiguous heading syntax of the four. */
const ATX = /^(#{1,6})\s+(\S.*?)\s*#*$/;

/** `4.` · `4.1` · `4.1.2 Charges` — how a policy document numbers a clause. */
const NUMBERED = /^\d+(?:\.\d+)*\.?\s+\S/;

/** `CHARGES AND FEES` — how one shouts a heading in a document with no styles. */
const SHOUTED = /^[A-Z0-9][A-Z0-9 .,'()&/–-]*[A-Z0-9)]$/;

/** The `====` or `----` under a Setext heading, and never a horizontal rule. */
const UNDERLINE = /^(=|-){3,}$/;

/**
 * A heading is short.
 *
 * The one property all four forms share, and the one that tells `4. Charges`
 * from `4. A transfer to another bank attracts a fee, which is debited at the
 * time the instruction is accepted.` Both are numbered lines; only one of them
 * is a heading, and length is what separates them without reading either.
 */
const MAX_HEADING_LENGTH = 90;

const isHeading = (line: string, next: string | undefined): boolean => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  if (ATX.test(trimmed)) return true;
  if (trimmed.length > MAX_HEADING_LENGTH) return false;
  if (next !== undefined && UNDERLINE.test(next.trim())) return true;
  // A heading does not end mid-sentence. A numbered line that ends in a full
  // stop or a comma is prose that happens to be numbered.
  if (/[.,;:]$/.test(trimmed) && !/^\d+(?:\.\d+)*\.$/.test(trimmed)) return false;
  if (NUMBERED.test(trimmed)) return true;
  return SHOUTED.test(trimmed) && /[A-Z]{2}/.test(trimmed);
};

const headingText = (line: string): string => {
  const trimmed = line.trim();
  const atx = ATX.exec(trimmed);
  return (atx?.[2] ?? trimmed).trim();
};

/**
 * Everything between one heading and the next, in reading order.
 *
 * Text before the first heading keeps a blank heading rather than being dropped.
 * A policy's opening paragraph is often the only place it says what it applies
 * to, and a Library that silently discarded it would answer *"does this cover
 * savings accounts"* from the middle of the document.
 */
export const sectionsIn = (text: string): readonly Section[] => {
  const lines = text.split("\n");
  const parts: { heading: string; body: string[] }[] = [{ heading: "", body: [] }];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const next = lines[index + 1];

    if (isHeading(line, next)) {
      parts.push({ heading: headingText(line), body: [] });
      // A Setext underline belongs to the heading above it, not to the body.
      if (next !== undefined && UNDERLINE.test(next.trim())) index += 1;
      continue;
    }
    parts[parts.length - 1]?.body.push(line);
  }

  return parts
    .map((part) => ({ heading: part.heading, body: part.body.join("\n").trim() }))
    // A heading with nothing under it is a chapter title, and citing one tells a
    // Customer nothing. It goes, and its text is not smuggled into its
    // neighbour — the next heading is the one that owns the prose beneath it.
    .filter((part) => part.body.length > 0)
    .flatMap((part) => splitLongSection(part.heading, part.body))
    .map((part, ordinal) => ({
      ordinal,
      heading: part.heading,
      body: part.body,
      tokenEstimate: estimateTokens(`${part.heading}\n${part.body}`),
    }));
};

/**
 * Splits at paragraphs until each piece fits, and never mid-sentence.
 *
 * A paragraph longer than the maximum on its own is left whole. Cutting it would
 * produce a citation pointing at half a sentence, and a section slightly over
 * the ceiling still fits a budget eleven times its size — the ceiling exists to
 * stop *one section being the entire document*, not to hold every row to a
 * length.
 */
const splitLongSection = (
  heading: string,
  body: string,
): readonly { heading: string; body: string }[] => {
  if (estimateTokens(body) <= MAX_SECTION_TOKENS) return [{ heading, body }];

  const pieces: { heading: string; body: string }[] = [];
  let current: string[] = [];

  const flush = (): void => {
    const joined = current.join("\n\n").trim();
    if (joined.length > 0) pieces.push({ heading, body: joined });
    current = [];
  };

  for (const paragraph of body.split(/\n{2,}/)) {
    if (paragraph.trim().length === 0) continue;
    if (current.length > 0 && estimateTokens([...current, paragraph].join("\n\n")) > MAX_SECTION_TOKENS) {
      flush();
    }
    current.push(paragraph.trim());
  }
  flush();

  return pieces.length > 0 ? pieces : [{ heading, body }];
};

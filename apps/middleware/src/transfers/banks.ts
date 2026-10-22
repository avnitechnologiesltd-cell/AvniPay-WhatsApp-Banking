import bankCodes from "./bank-codes.json";

/**
 * The other banks, and their **NIBSS codes**.
 *
 * An Intent carries the bank as the Customer said it — *"GTBank"*, *"gtb"*,
 * *"Guaranty Trust"* — and `Transfer/InterBankTransfer` needs a NIBSS code. This
 * module is where one becomes the other.
 *
 * ## Where the codes come from
 *
 * **`bank-codes.json` is the Bank's own list**, kept verbatim as it was handed
 * over — envelope, `id` fields and all — so that refreshing it is an overwrite
 * rather than an edit. There is no step between what the Bank sent and what the
 * Middleware routes on, which is the point: a transcription is a place for a
 * typo, and a typo here is a payment to another institution.
 *
 * This replaced a table compiled from memory, and it is worth recording what
 * that cost, because it is the argument against ever doing it again: of
 * thirty-four rows, **nine were wrong**. Eight banks had been reissued codes in
 * the `000025`–`000031` range. One was worse — `303` was written down as Lotus
 * Bank and belongs to ChamsMobile, so every naira sent to Lotus would have gone
 * to a different institution with a correct-looking Confirmation screen in
 * front of it. Lotus is `000029`.
 *
 * ## The two matching rules
 *
 * **A name that does not match exactly is not matched at all.** The Bank's own
 * name is recognised loosely by `routing.ts` — a word in common is enough,
 * because a Customer talking to their own bank says *"my bank"* and *"Example"* —
 * and that rule is wrong here. Shared words are how *"First Bank"* becomes
 * *"First City Monument Bank"*, and this is a directory where a near miss is a
 * payment to a stranger at the wrong institution.
 *
 * **A spelling that names two institutions names neither.** The list has no such
 * collision today and the test holds it to that; if a refresh introduces one,
 * the ambiguous name resolves to nothing and the Customer is asked to say it
 * another way. Silently picking whichever row came first is the failure this
 * whole module exists to avoid.
 *
 * A bank the list does not hold is refused, never guessed at. The Customer is
 * told the bank was not recognised and can say it another way, which costs them
 * a sentence; the opposite mistake costs them the money.
 */

export interface NigerianBank {
  /** The NIBSS code. Three or six digits, and a handful of five. */
  readonly code: string;
  /** The bank's own name, and what the Confirmation screen shows. */
  readonly name: string;
}

/**
 * The Bank's list, as it arrived. `data` is the only part that is routed on.
 *
 * **Trimmed on the way in, and that is not cosmetic.** Eight rows carry a stray
 * space — one of them on the *code*, `"090603 "` for Macrod MFB — and a code
 * with a space in it goes onto the wire as `ReceiverBankCode` and is a transfer
 * that fails, or worse, one that matches nothing and is not the bank the
 * Customer chose. The file stays exactly as the Bank sent it and the reader is
 * tolerant, which is the same division of labour the BankOne adapter keeps with
 * BankOne's own field spellings.
 */
export const NIGERIAN_BANKS: readonly NigerianBank[] = bankCodes.data.map((bank) => ({
  code: bank.code.trim(),
  name: bank.name.trim(),
}));

/**
 * What a Customer types instead of what the list calls a bank.
 *
 * Every entry here is a **judgement**, which is why they are written out rather
 * than derived: *"fbn"* is First Bank rather than FBNMobile, *"stanbic"* is the
 * bank rather than the @ease wallet. Each one resolves to a code the Bank's list
 * holds, and the test refuses any that does not — an alias may abbreviate the
 * list, never extend it.
 *
 * Three kinds of entry, and all three are things people actually say:
 *
 * - **Initialisms**, which no list spells out: `gtb`, `uba`, `fcmb`.
 * - **Short names**, where the list is formal: the list says *"Moniepoint
 *   Microfinance Bank"* and nobody says the last two words.
 * - **Former names**, because a Customer paying *"Skye Bank"* means Polaris and
 *   refusing that would refuse a transfer that can be made.
 *
 * `standard chartered` is here for a fourth reason worth naming: the Bank's list
 * spells it *"Standard Chaterted bank PLC"*. The list is the source of truth for
 * **codes**, and it is not proof-read.
 */
const ALIASES: Readonly<Record<string, string>> = {
  // Initialisms
  gtb: "058",
  gtbank: "058",
  "gt bank": "058",
  uba: "033",
  fbn: "011",
  firstbank: "011",
  fcmb: "214",
  stanchart: "068",
  ibtc: "221",
  vfd: "090110",

  // Short names, where the list is formal or run together
  moniepoint: "50515",
  "monie point": "50515",
  fairmoney: "090551",
  providus: "101",
  citibank: "023",
  stanbic: "221",
  eco: "050",
  rubies: "090175",
  "kuda microfinance bank": "090267",
  "standard chartered": "068",

  // Former names, still in use
  skye: "076",
  diamond: "044",
  alat: "035",
};

/**
 * Words that say *bank* rather than say *which* bank, dropped from both sides
 * before comparing.
 *
 * Shorter than the set the Bank's own name is matched against, and deliberately
 * so. *"MFB"* and *"microfinance"* stay significant here, because at this Bank
 * they are noise — *"Example MFB"* and *"Example"* are one institution — and in
 * this list they are the difference between Sterling Bank and one of the several
 * microfinance banks that share a word with a commercial one. A Customer who
 * names one of those is told their bank was not recognised, which is true.
 */
const GENERIC = new Set(["bank", "banks", "plc", "ltd", "limited", "nigeria", "of", "the"]);

/** Lowercase, punctuation stripped, bank-words dropped, single-spaced. */
const normalise = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((word) => word.length > 0 && !GENERIC.has(word))
    .join(" ");

const BY_CODE = new Map(NIGERIAN_BANKS.map((bank) => [bank.code, bank] as const));

/**
 * Every spelling that reaches exactly one institution.
 *
 * A spelling claimed by two different codes is **removed rather than resolved**,
 * so an ambiguous name answers nothing and is refused upstream.
 */
const BY_NAME = ((): ReadonlyMap<string, NigerianBank> => {
  const found = new Map<string, NigerianBank>();
  const ambiguous = new Set<string>();

  for (const bank of NIGERIAN_BANKS) {
    const spelling = normalise(bank.name);
    const already = found.get(spelling);
    // The same institution listed twice under two spellings of its own name is
    // not an ambiguity — the list does that, and both rows carry one code.
    if (already && already.code !== bank.code) ambiguous.add(spelling);
    else found.set(spelling, bank);
  }

  for (const spelling of ambiguous) found.delete(spelling);

  for (const [alias, code] of Object.entries(ALIASES)) {
    const bank = BY_CODE.get(code);
    // An alias for a code the list does not hold is dropped rather than
    // invented. The test fails on it; production refuses the name.
    if (bank) found.set(normalise(alias), bank);
  }

  return found;
})();

/**
 * The bank a Customer named, or nothing at all.
 *
 * Nothing is the answer that matters: it is what a Customer who typed a name
 * this list does not hold gets, and it ends the transfer before any money
 * moves. It never falls back to a near match.
 */
export const findBank = (stated: string): NigerianBank | undefined =>
  BY_NAME.get(normalise(stated));

/** For the test that holds the aliases to the Bank's own list. */
export const BANK_ALIASES = ALIASES;

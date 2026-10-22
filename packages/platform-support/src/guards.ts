/**
 * The four things the Support Agent may not say, checked in code after the model
 * has said them.
 *
 * **Every one of these is a rule the prompt also states, and stating them twice
 * is the point.** The prior art asserted *"Maximum single transfer:
 * ₦1,000,000"* and a ₦30 fee in a hardcoded system prompt; both figures were
 * invented, both were told to Customers with total confidence, and limits are in
 * fact KYC-tier and not observable at all. A rule that lives only in a prompt is
 * a rule a model at roughly 68% multi-turn reliability follows roughly that
 * often.
 *
 * So the prompt asks, and this refuses. What it costs is over-refusal — an
 * answer that mentions a number nobody gave it becomes a Handoff — and that cost
 * is accepted, because the direction it fails in is a human reading the
 * conversation rather than a Customer acting on a figure that is not the Bank's.
 */

/**
 * Every number in a piece of text, normalised so `1,000` and `1000` are the same
 * figure.
 *
 * Deliberately crude. It is not trying to understand what a number *means* — it
 * is answering *was this figure in front of the model*, and for that a string
 * comparison over digits is exactly right and cannot be argued with.
 */
export const figuresIn = (text: string): readonly string[] => [
  ...new Set(
    (text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((figure) =>
      figure.replace(/,/g, "").replace(/\.0+$/, ""),
    ),
  ),
];

/**
 * Figures in `answer` that are in none of `sources`.
 *
 * `sources` is everything the model was legitimately given: the sections
 * retrieved **this turn**, and the Customer's own words. The second matters — a
 * Customer asking *"is there a charge on 50,000?"* and being answered *"there is
 * no charge on 50,000"* is the Agent repeating them, not inventing a figure, and
 * refusing that would be over-refusal with no safety in it.
 *
 * **The Agent's own earlier replies are deliberately not a source**, and that is
 * the subtle half. Counting them is circular — the model's past claim becomes
 * evidence for its next one — and it has a concrete failure: a policy quoted
 * correctly at 9am and *withdrawn* at 10am is still sitting in the conversation,
 * and treating it as grounding would let the Agent go on repeating a figure the
 * Bank has taken down. Withdrawal has to be complete in the very next turn, and
 * that includes the turns of a conversation already under way.
 */
export const ungroundedFigures = (
  answer: string,
  sources: readonly string[],
): readonly string[] => {
  const given = new Set(sources.flatMap((source) => figuresIn(source)));
  return figuresIn(answer).filter((figure) => !given.has(figure));
};

/**
 * The vocabulary of a claim about the Bank, in the four categories the ticket
 * names — a **fee**, a **limit**, a **timeframe**, an **exchange rate** — plus
 * the language policy itself is written in.
 *
 * Deliberately a word list and not a judgement. A second model call asked to
 * decide *"is this a policy claim?"* would be another ~68% classifier in front
 * of the one rule this whole slice exists to make certain, and its failures
 * would be silent. A word list fails loudly and in one direction: towards a
 * human.
 */
const CLAIM =
  /\b(fees?|charges?|charged|chargeable|tariffs?|commissions?|costs?|free|limits?|maximum|minimum|cap|caps|capped|thresholds?|rates?|exchange|working days?|business days?|days?|weeks?|hours?|minutes?|instantly|immediately|within|policy|policies|requires?|required|must|eligible|eligibility|allowed|permitted|entitled|guaranteed?)\b/i;

/**
 * Whether an answer with **no citation behind it** nonetheless makes a claim
 * about the Bank.
 *
 * This is the refusal rule closing its own last gap. *A search that returns
 * nothing ends the turn* covers the model that looked; this covers the model
 * that **did not look at all** — which the prompt forbids for anything about the
 * Bank, and a prompt is not a mechanism.
 *
 * The figures guard alone was not enough and the shape of the miss is worth
 * recording: *"transfers arrive within two working days"* contains no digit, so
 * it is an invented timeframe that would have gone straight to a Customer. The
 * ticket asks for *a fee, a limit, a **timeframe** or an exchange rate*, and
 * only one of those four is reliably a numeral.
 *
 * What survives with an empty Library is what the Agent can say about *itself* —
 * that it is an AI, what it can help with, that it is fetching a person. That is
 * exactly *"answers from its own instructions and hands off every policy
 * question"*, which is the day-one behaviour the design asked for.
 */
export const makesAnUncitedClaim = (answer: string): boolean => CLAIM.test(answer);

/**
 * Whether the Agent is claiming to be a person.
 *
 * The disclosure rule with something behind it. *"It identifies itself as an AI
 * when asked and never claims to be a person"* was a sentence in the prompt and
 * nothing else — and swapping a human for an AI without saying so is a
 * disclosure problem for a licensed institution, which makes it the wrong rule
 * to leave to a model's good behaviour.
 *
 * It catches the assertion rather than the absence of one: a reply that simply
 * does not mention what it is is ordinary, and a reply that says it is human is
 * not sent at all.
 */
export const claimsToBeAPerson = (answer: string): boolean =>
  /\bi(?:'m| am)\s+(?:a\s+|an\s+)?(?:human|real person|person|man|woman|human being)\b/i.test(
    answer,
  ) ||
  /\bi(?:'m| am)\s+not\s+(?:a\s+|an\s+)?(?:ai|a\.i\.|bot|robot|machine|computer|chatbot|programme?|program)\b/i.test(
    answer,
  ) ||
  /\byou(?:'re| are)\s+(?:speaking|talking|chatting)\s+(?:to|with)\s+(?:a\s+)?(?:real\s+)?(?:human|person)\b/i.test(
    answer,
  );

/** The secrets that belong in a sealed surface and never in a conversation. */
const SECRET = "pin|otp|one[- ]time (?:code|password|pin)|bvn|passwords?|passcode|cvv|card number";

/**
 * A request **for one**, and the two words between the verb and the secret are
 * what make it one.
 *
 * Proximity alone is not enough, and *"you can set a new PIN when you next send
 * money"* is why: it contains a request verb and a secret four words apart and
 * asks for nothing. What distinguishes a solicitation is that the secret is the
 * verb's object — so the pattern requires it to follow the verb directly.
 */
const REQUEST = new RegExp(
  String.raw`\b(?:send|share|give|enter|type|provide|confirm|tell|reply with|forward|paste)\s+` +
    String.raw`(?:me\s+|us\s+)?(?:your|the|a|an|that)?\s*(?:${SECRET})\b` +
    String.raw`|\bwhat(?:'s| is)\s+(?:your|the)\s+(?:${SECRET})\b`,
  "i",
);

/** What turns *"never share your PIN"* from a solicitation into advice. */
const NOT = /\b(never|not|n't|no need|nobody|no one|will not|cannot|won't|do not)\b/i;

/**
 * Whether the Agent is asking a Customer for a secret.
 *
 * **Sentence by sentence, and a negation clears the sentence it is in.** The
 * Agent's *correct* behaviour when a Customer volunteers a PIN is to tell them
 * never to share it — a sentence containing both "share" and "PIN" — so a guard
 * that read the reply as one block would refuse the one reply this rule exists
 * to produce.
 */
export const asksForASecret = (text: string): boolean =>
  text.split(/(?<=[.!?\n])\s+/).some((sentence) => REQUEST.test(sentence) && !NOT.test(sentence));

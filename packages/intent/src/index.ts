import { z } from "zod";

import { TRANSACTION_PERIODS } from "./period";

export type {
  AuthorisationRequiredOutcome,
  BalanceOutcome,
  BankUnknownOutcome,
  BeneficiaryChoiceRequiredOutcome,
  BeneficiaryUnreachableOutcome,
  DestinationUnknownOutcome,
  FailedOutcome,
  IntentOutcome,
  NoSuchBeneficiaryOutcome,
  NotAvailableOutcome,
  NotIdentifiedOutcome,
  OpenedConversation,
  SealedSurfaceAddress,
  SurfaceNotApplicable,
  TransactionDirection,
  TransactionRow,
  TransactionsOutcome,
  UnsupportedOutcome,
} from "./outcome";
export { formatNaira } from "./naira";
export { TRANSACTION_PERIODS, type TransactionPeriod } from "./period";

/**
 * An **Intent** is what a Customer asked for. A **Mandate** is what they
 * authorised. They are two types, and only a Mandate reaches BankOne
 * ([ADR-0008](../../../docs/adr/0008-an-intent-becomes-a-mandate-when-authorised.md)).
 *
 * This file is the Intent half, and it is deliberately the smaller one. An
 * Intent carries the request and nothing else: no source account, no Customer
 * identifier, no authorisation, no reference. Every field an attacker would
 * want to control exists only on the Mandate, and only the Middleware writes
 * it — so the Orchestration Layer producing this object cannot name whose money
 * moves ([ADR-0006](../../../docs/adr/0006-secrets-and-security-records-live-outside-the-platform.md)).
 *
 * The union is **closed**. A new capability is a new variant that every module
 * compiles against, never a paragraph added to a prompt
 * ([ADR-0001](../../../docs/adr/0001-no-ai-in-the-banking-layer.md)).
 */

/** Naira. Never kobo, and never divided by 100. */
const amount = z
  .number()
  .finite("must be a number")
  .positive("must be more than nothing")
  .refine((value) => Math.round(value * 100) === value * 100, "must not be finer than a kobo");

/** Free text the model extracted. Whether it resolves is the Middleware's job. */
const extracted = z.string().trim().min(1);

// --- The variants ------------------------------------------------------------
//
// `.strict()` on each is the load-bearing part. Without it a model — or an
// injected Platform — could attach `sourceAccount` and have it silently
// carried, which is the decorative version of ADR-0001.

const checkBalance = z.object({ kind: z.literal("check_balance") }).strict();

const listTransactions = z
  .object({
    kind: z.literal("list_transactions"),
    period: z.enum(TRANSACTION_PERIODS),
  })
  .strict();

/** "send 5000 to Musa" — by a name the Customer saved. */
const transferToBeneficiary = z
  .object({
    kind: z.literal("transfer_to_beneficiary"),
    amount,
    beneficiaryName: extracted,
  })
  .strict();

/**
 * "send 2000 to 2124955312 at Access Bank" — by number and bank.
 *
 * **`bankName` may be blank, and that is a value rather than a gap.** Groq's
 * `strict: true` requires every property to be present, so a Customer who named
 * no bank — *"send 2000 to 2124955312"*, which is how most of them say it —
 * leaves the model with a field it must fill and nothing true to put in it. The
 * alternative to allowing blank is a model inventing a bank on the one Intent
 * that moves money.
 *
 * Blank means *the Customer named no bank*, and the Middleware reads it as their
 * own — the destination bank and the name that account holds are on the
 * Confirmation screen either way, so a Customer who meant another bank sees it
 * before the PIN rather than after the debit.
 */
const transferToAccount = z
  .object({
    kind: z.literal("transfer_to_account"),
    amount,
    accountNumber: extracted,
    bankName: z.string().trim(),
  })
  .strict();

/**
 * "forget Musa", "remove Ade from my saved list".
 *
 * It carries the same lone string `transfer_to_beneficiary` does, and for the
 * same reason: the Orchestration Layer extracts what the Customer called
 * somebody and **never reads the store**
 * ([ADR-0008](../../../docs/adr/0008-an-intent-becomes-a-mandate-when-authorised.md)).
 *
 * Nothing is deleted where this is resolved, and nothing is deleted by the model
 * that produced it. It opens the same Disambiguation screen a transfer opens,
 * and the Customer's *tap* is what removes a record — which is what makes
 * *"forget Musa"* handle two Musas correctly instead of guessing at one.
 */
const forgetBeneficiary = z
  .object({
    kind: z.literal("forget_beneficiary"),
    beneficiaryName: extracted,
  })
  .strict();

/**
 * "unlink my number", "stop whatsapp banking", "I forgot my PIN".
 *
 * These are things a Customer genuinely says, and they are **not banking** —
 * they change who reaches an account and what authorises a Mandate, and they
 * move no money. That difference is a type rather than a comment: the Banking
 * Layer is handed a `BankingIntent` and cannot be given one of these at all.
 *
 * Neither is acted on where it is resolved. An `unlink` becomes a control the
 * Customer taps, because a model that can revoke a Binding is a prompt injection
 * away from doing it; a `reset_pin` becomes a sealed surface and a code to the
 * contact already on record, which is the same root of trust that authorised the
 * enrollment in the first place.
 */
const unlink = z.object({ kind: z.literal("unlink") }).strict();
const resetPin = z.object({ kind: z.literal("reset_pin") }).strict();

/**
 * "let me speak to someone", "I want a human", "put me through to an agent".
 *
 * **Handoff trigger 2**, and a variant rather than a keyword. *"Reply HELP"* was
 * the shape this nearly took, and it is the shape to avoid: a word a Customer
 * has to type is a word that then has to be told apart from a sentence they
 * meant, on the one path where getting it wrong means arguing with somebody who
 * has already asked for a person.
 *
 * It moves no money and changes no access, so it sits with `unlink` and
 * `reset_pin` outside `BankingIntent` — and like both of those, nothing is acted
 * on where it is resolved. The Platform asks the Middleware for a Handoff; the
 * Orchestration Layer has recognised a request and done nothing else.
 */
const talkToHuman = z.object({ kind: z.literal("talk_to_human") }).strict();

/**
 * *"What do you charge to send to another bank?"*, *"how do I close my
 * account"*, *"are you a robot"*.
 *
 * **A question for the Support Agent**, and the variant that stops the resolver
 * being told to pick the closest banking intent for something that is not one.
 * Without it, *"what is your transfer fee"* resolves to `transfer_to_account`
 * with an invented amount, which is the failure this whole slice exists to make
 * impossible.
 *
 * It carries **nothing** — not the question, not a topic, not a rewrite of what
 * the Customer said. An Intent carries the request and nothing else, and the
 * composer already holds the Customer's own words; a field here would be the
 * model's paraphrase of them travelling as if it were the thing they typed.
 *
 * Two separate model calls follow from this, and the provider insists on it:
 * structured output and tool use are mutually exclusive on Groq
 * (ticket 04),
 * so the Agent that reads the **Library** and calls Connectors physically cannot
 * emit a schema-guaranteed Intent in the same breath.
 */
const askSupport = z.object({ kind: z.literal("ask_support") }).strict();

/**
 * What the Banking Layer will accept.
 *
 * `forget_beneficiary` is in here and it moves no money, which is worth stating
 * rather than leaving to be noticed. The Beneficiary store is **the thing that
 * decides where a transfer is offered to go**, so it sits behind the same
 * boundary the transfer does: the layer that resolves a saved recipient is the
 * layer that forgets one, and neither the Platform nor the model reaches either.
 * Nothing about a deletion is sent to BankOne, because there is nothing there to
 * send it to.
 */
const BANKING_KINDS = [
  "check_balance",
  "list_transactions",
  "transfer_to_beneficiary",
  "transfer_to_account",
  "forget_beneficiary",
] as const;

export const intentSchema = z.discriminatedUnion("kind", [
  checkBalance,
  listTransactions,
  transferToBeneficiary,
  transferToAccount,
  forgetBeneficiary,
  unlink,
  resetPin,
  talkToHuman,
  askSupport,
]);

export type Intent = z.infer<typeof intentSchema>;
export type IntentKind = Intent["kind"];

export type CheckBalanceIntent = z.infer<typeof checkBalance>;
export type ListTransactionsIntent = z.infer<typeof listTransactions>;
export type TransferToBeneficiaryIntent = z.infer<typeof transferToBeneficiary>;
export type TransferToAccountIntent = z.infer<typeof transferToAccount>;
export type ForgetBeneficiaryIntent = z.infer<typeof forgetBeneficiary>;
export type UnlinkIntent = z.infer<typeof unlink>;
export type ResetPinIntent = z.infer<typeof resetPin>;
export type TalkToHumanIntent = z.infer<typeof talkToHuman>;
export type AskSupportIntent = z.infer<typeof askSupport>;

/** What the Banking Layer takes. See `BANKING_KINDS` for the one odd member. */
export type BankingIntent = Extract<Intent, { kind: (typeof BANKING_KINDS)[number] }>;

/**
 * Everything the Banking Layer will not take.
 *
 * Three shapes of thing rather than one, and they are worth naming: `unlink`
 * and `reset_pin` change who reaches an account, `talk_to_human` asks for a
 * person, and `ask_support` is a question. What they share is the only property
 * this type is used for — the Middleware's intents endpoint refuses every one
 * of them, so none can be smuggled onto the money path.
 */
export type NonBankingIntent = Exclude<Intent, BankingIntent>;

export const isBankingIntent = (intent: Intent): intent is BankingIntent =>
  (BANKING_KINDS as readonly string[]).includes(intent.kind);

/** Throws unless `value` is exactly one of the variants above. */
export const parseIntent = (value: unknown): Intent => intentSchema.parse(value);

/** Does not throw. For a boundary that wants to answer rather than fail. */
export const safeParseIntent = (
  value: unknown,
): { ok: true; intent: Intent } | { ok: false; error: string } => {
  const result = intentSchema.safeParse(value);
  return result.success
    ? { ok: true, intent: result.data }
    : { ok: false, error: result.error.issues.map((issue) => issue.message).join("; ") };
};

// --- The schema Groq is given ------------------------------------------------

interface JsonProperty {
  readonly type: string;
  readonly enum?: readonly string[];
  readonly description?: string;
}

interface JsonVariant {
  readonly type: "object";
  readonly properties: Readonly<Record<string, JsonProperty>>;
  readonly required: readonly string[];
  readonly additionalProperties: false;
}

const NAIRA = { type: "number", description: "Amount in naira, not kobo." } as const;

/**
 * The properties of each variant, beside its Zod shape rather than derived from
 * it. Derivation would need a Zod-to-JSON-Schema pass whose output Groq's strict
 * mode constrains anyway; the two lists are instead kept honest by a test that
 * builds a sample from each JSON variant and parses it through the union above.
 */
const JSON_PROPERTIES: Record<IntentKind, Readonly<Record<string, JsonProperty>>> = {
  check_balance: {},
  list_transactions: {
    period: { type: "string", enum: [...TRANSACTION_PERIODS] },
  },
  transfer_to_beneficiary: {
    amount: NAIRA,
    beneficiaryName: {
      type: "string",
      description: "The saved name the Customer used. Never an account number.",
    },
  },
  transfer_to_account: {
    amount: NAIRA,
    accountNumber: { type: "string", description: "The account number as the Customer said it." },
    bankName: {
      type: "string",
      description: "The bank as the Customer named it. Empty if they named none — never guess one.",
    },
  },
  forget_beneficiary: {
    beneficiaryName: {
      type: "string",
      description: "The saved name the Customer wants removed. Never an account number.",
    },
  },
  unlink: {},
  reset_pin: {},
  talk_to_human: {},
  ask_support: {},
};

export const INTENT_KINDS = Object.keys(JSON_PROPERTIES) as readonly IntentKind[];

const jsonVariant = (kind: IntentKind): JsonVariant => {
  const properties = {
    kind: { type: "string", enum: [kind] },
    ...JSON_PROPERTIES[kind],
  };

  return {
    type: "object",
    properties,
    // Every property, not the subset that happens to be mandatory. Groq's
    // strict mode requires all of them present — which is why the two transfer
    // variants are separate rather than one shape with nullable fields the
    // model would have to reason about.
    required: Object.keys(properties),
    additionalProperties: false,
  };
};

/**
 * The key the union is wrapped under. See `INTENT_JSON_SCHEMA`.
 */
export const INTENT_ENVELOPE_KEY = "intent";

/**
 * `response_format: { type: "json_schema", json_schema: INTENT_JSON_SCHEMA }`.
 *
 * `strict: true` is a token-level guarantee, so an Intent that comes back is an
 * Intent that fits this shape. It guarantees the shape and **never the values**
 * — Groq will happily emit a perfectly-formed transfer with the wrong amount in
 * it, which is why the Confirmation screen exists and why no read path here
 * moves money.
 *
 * **The union is wrapped in an object rather than sitting at the top level.**
 * Groq refuses a schema whose root is `anyOf`:
 *
 * > schema must have type 'object' and not have 'oneOf'/'anyOf'/'enum'/'not'
 * > at the top level
 *
 * An Intent *is* a union, so the wrapper is the smallest thing that keeps the
 * union while satisfying that rule — one required property holding it. What
 * comes back is `{"intent": {...}}` and `intentFromEnvelope` takes it out
 * again, so nothing downstream of the resolver learns about this.
 */
export const INTENT_JSON_SCHEMA = {
  name: "intent",
  strict: true,
  schema: {
    type: "object",
    properties: {
      [INTENT_ENVELOPE_KEY]: { anyOf: INTENT_KINDS.map(jsonVariant) },
    },
    required: [INTENT_ENVELOPE_KEY],
    additionalProperties: false,
  },
} as const;

/**
 * The Intent inside the envelope above, or the value unchanged if it is not
 * wrapped.
 *
 * Tolerant of both because the wrapper is a provider's constraint rather than
 * part of the contract: a model that answers with a bare Intent is answering
 * correctly, and refusing it would be this platform enforcing Groq's rule on
 * everyone else's behalf.
 */
export const intentFromEnvelope = (parsed: unknown): unknown =>
  typeof parsed === "object" && parsed !== null && INTENT_ENVELOPE_KEY in parsed
    ? (parsed as Record<string, unknown>)[INTENT_ENVELOPE_KEY]
    : parsed;

/**
 * **The menu**, and the ids the two taps come back as.
 *
 * It lives in `@avni/intent` because both deployables render it and neither
 * owns it: the Middleware sends it once, immediately after enrollment, because
 * that walk terminated there and the Platform is never told it finished — and
 * the Platform sends it every time a Customer says hello. Two senders, one list,
 * so a button can never exist in one place and not the other.
 *
 * The ids are minted by us and come back unchanged, which is what lets a tap be
 * routed by code with no model reading it (`chose`, not `said`).
 */
export const MENU_CHOICES = {
  sendMoney: "menu_send_money",
  buyAirtime: "menu_buy_airtime",
  checkBalance: "menu_check_balance",
} as const;

/**
 * What the buttons say. **WhatsApp truncates a reply button past 20
 * characters**, so these are short because they have to be, not for taste.
 */
export const MENU_BUTTONS = [
  { id: MENU_CHOICES.sendMoney, title: "Send Money" },
  { id: MENU_CHOICES.buyAirtime, title: "Buy Airtime" },
  { id: MENU_CHOICES.checkBalance, title: "Check Balance" },
] as const;

/** The line above the buttons. */
export const MENU_PROMPT = "What would you like to do?";

/**
 * The sentence a Customer reads once, in the conversation, just after the Flow
 * that linked them closes.
 *
 * Said here rather than on the Flow's last screen because a list of things you
 * can do is only useful beside the buttons that do them — and that screen is one
 * the Customer is already closing.
 */
export const welcomeAfterEnrollment = (bankName: string): string =>
  `🎉 You're all set! Your ${bankName} account is connected.\n\n` +
  "You can send money, buy airtime, check your balance and more — right here on WhatsApp.";

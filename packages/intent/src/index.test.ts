import { describe, expect, it } from "vitest";

import {
  INTENT_JSON_SCHEMA,
  intentFromEnvelope,
  INTENT_KINDS,
  isBankingIntent,
  parseIntent,
  type Intent,
} from "./index";

describe("the Intent union", () => {
  it("accepts a balance enquiry, which resolves nothing", () => {
    expect(parseIntent({ kind: "check_balance" })).toEqual({ kind: "check_balance" });
  });

  it("accepts the nine kinds v1 ships", () => {
    expect([...INTENT_KINDS]).toEqual([
      "check_balance",
      "list_transactions",
      "transfer_to_beneficiary",
      "transfer_to_account",
      "forget_beneficiary",
      "unlink",
      "reset_pin",
      // Handoff trigger 2. A variant rather than a keyword, because *"reply
      // HELP"* is a word a Customer has to type and then has to be told apart
      // from a sentence they meant — on the one path where getting it wrong
      // means arguing with somebody who has already asked for a person.
      "talk_to_human",
      // A question rather than an instruction, and the variant that stops the
      // resolver picking the closest banking intent for something that is not
      // one. *"What do you charge to send to GTB"* used to resolve to a
      // transfer with an invented amount in it.
      "ask_support",
    ]);
  });

  it("carries a name and nothing else on a request to forget a saved recipient", () => {
    // The same lone string a transfer by name carries. The Orchestration Layer
    // extracts what the Customer called somebody and never reads the store, so
    // there is no record id here for a model to be talked into naming.
    expect(parseIntent({ kind: "forget_beneficiary", beneficiaryName: "Musa" })).toEqual({
      kind: "forget_beneficiary",
      beneficiaryName: "Musa",
    });
    expect(() =>
      parseIntent({ kind: "forget_beneficiary", beneficiaryName: "Musa", beneficiaryId: "b-1" }),
    ).toThrow();
  });

  it("keeps every non-banking kind out of the Banking Layer's reach", () => {
    // A type rather than a comment: `BankingService` takes a `BankingIntent`, so
    // "unlinking is not banking" is something the compiler holds rather than
    // something a future caller has to remember.
    expect(isBankingIntent(parseIntent({ kind: "check_balance" }))).toBe(true);
    expect(isBankingIntent(parseIntent({ kind: "unlink" }))).toBe(false);
    expect(isBankingIntent(parseIntent({ kind: "reset_pin" }))).toBe(false);
    // The Support Agent's own. It reaches a model and never the money path —
    // the intents endpoint refuses it, so a question cannot become an
    // instruction by being submitted somewhere it does not belong.
    expect(isBankingIntent(parseIntent({ kind: "ask_support" }))).toBe(false);
  });

  it("gives a question no field for the model to fill", () => {
    // An Intent carries the request and nothing else. The composer already has
    // the Customer's own words; a `question` field here would be the model's
    // paraphrase of them travelling as if it were the thing they typed.
    expect(parseIntent({ kind: "ask_support" })).toEqual({ kind: "ask_support" });
    expect(() => parseIntent({ kind: "ask_support", question: "what is the fee" })).toThrow();
  });

  it("refuses a kind the model invented", () => {
    // The union is closed. A new capability is a new variant every module
    // compiles against, never a paragraph added to a prompt (ADR-0001).
    expect(() => parseIntent({ kind: "close_my_account" })).toThrow();
    expect(() => parseIntent({ kind: "check_balance_now" })).toThrow();
  });

  it("refuses an account number on a balance enquiry", () => {
    // Every field an attacker would want to control exists only on the Mandate,
    // and only the Middleware writes it (ADR-0008). The Intent names no account.
    expect(() =>
      parseIntent({ kind: "check_balance", accountNumber: "0123456789" }),
    ).toThrow();
  });

  it("refuses a Customer identifier on any variant", () => {
    // ADR-0006: if the Platform can name whose account to debit, the Binding is
    // decorative.
    for (const extra of [
      { customerId: "C-1" },
      { channelIdentity: "2348012345678" },
      { sourceAccount: "0123456789" },
      { confirmed: true },
      { reference: "ABC123" },
    ]) {
      expect(() => parseIntent({ kind: "check_balance", ...extra })).toThrow();
    }
  });

  it("keeps transaction history in the union even though it is unentitled", () => {
    // Leaving it out means reopening the union later, and the union is the one
    // thing every module compiles against. The Middleware answers *not
    // available* until the first deployment's entitlement arrives (ticket 14, A.1).
    expect(parseIntent({ kind: "list_transactions", period: "last_month" })).toEqual({
      kind: "list_transactions",
      period: "last_month",
    });
  });

  it("does not split intra-bank from inter-bank", () => {
    // The Customer does not know or care which one they are doing; the
    // Middleware decides from the bank code.
    expect([...INTENT_KINDS].filter((kind) => /intra|inter|nip/i.test(kind))).toEqual([]);
  });

  it("carries a transfer by saved name with no account resolved", () => {
    const intent = parseIntent({
      kind: "transfer_to_beneficiary",
      amount: 5000,
      beneficiaryName: "Musa",
    });

    expect(intent).toEqual({
      kind: "transfer_to_beneficiary",
      amount: 5000,
      beneficiaryName: "Musa",
    });
  });

  it("refuses an amount that is not money a Customer could send", () => {
    for (const amount of [0, -100, 1.005, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        parseIntent({ kind: "transfer_to_beneficiary", amount, beneficiaryName: "Musa" }),
      ).toThrow();
    }
  });

  it("narrows to the variant on the kind alone", () => {
    const intent: Intent = parseIntent({ kind: "check_balance" });

    // A compile-time check as much as a runtime one: the union discriminates.
    if (intent.kind === "transfer_to_account") expect.unreachable();
    expect(intent.kind).toBe("check_balance");
  });
});

describe("the JSON schema sent to Groq", () => {
  // The union sits under one required property rather than at the top level,
  // because Groq refuses a schema whose root is `anyOf`. See INTENT_JSON_SCHEMA.
  const variants = INTENT_JSON_SCHEMA.schema.properties.intent.anyOf;

  it("puts the union inside an object, which is the only shape Groq accepts", () => {
    // Verbatim from Groq on the top-level form: "schema must have type 'object'
    // and not have 'oneOf'/'anyOf'/'enum'/'not' at the top level". Every
    // Customer message failed with HTTP 400 until this wrapper existed.
    expect(INTENT_JSON_SCHEMA.schema.type).toBe("object");
    expect(INTENT_JSON_SCHEMA.schema).not.toHaveProperty("anyOf");
    expect(INTENT_JSON_SCHEMA.schema.required).toEqual(["intent"]);
    expect(INTENT_JSON_SCHEMA.schema.additionalProperties).toBe(false);
  });

  it("unwraps what the model answers, and leaves a bare Intent alone", () => {
    expect(intentFromEnvelope({ intent: { kind: "check_balance" } })).toEqual({
      kind: "check_balance",
    });
    expect(intentFromEnvelope({ kind: "check_balance" })).toEqual({ kind: "check_balance" });
  });

  it("offers one variant per kind", () => {
    expect(variants).toHaveLength(INTENT_KINDS.length);
  });

  it("closes every variant to additional properties", () => {
    // strict: true is a token-level guarantee. An open object would let the
    // model attach a field nothing validates.
    for (const variant of variants) {
      expect(variant.additionalProperties).toBe(false);
    }
  });

  it("requires every property of every variant", () => {
    // Groq's strict mode requires every declared property to be present, which
    // is why the two transfer variants are separate rather than one shape with
    // nullable fields the model would have to reason about.
    for (const variant of variants) {
      expect([...variant.required].sort()).toEqual(Object.keys(variant.properties).sort());
    }
  });

  it("pins each variant's kind to a single literal", () => {
    expect(variants.map((variant) => variant.properties["kind"]?.enum?.[0])).toEqual([
      ...INTENT_KINDS,
    ]);
  });

  it("is marked strict, which is what makes the shape a guarantee", () => {
    expect(INTENT_JSON_SCHEMA.strict).toBe(true);
  });

  it("describes no field the union would then reject", () => {
    // The one thing keeping the schema Groq sees and the union we validate
    // against from drifting apart: build a sample from each JSON variant and
    // put it through the real parser.
    for (const variant of variants) {
      const sample = Object.fromEntries(
        Object.entries(variant.properties).map(([name, property]) => [
          name,
          property.enum ? property.enum[0] : property.type === "number" ? 1000 : "x",
        ]),
      );

      expect(() => parseIntent(sample)).not.toThrow();
    }
  });
});

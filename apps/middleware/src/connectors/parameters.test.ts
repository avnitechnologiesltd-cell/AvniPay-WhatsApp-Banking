import { describe, expect, it } from "vitest";

import {
  MAX_PARAMETERS,
  checkArguments,
  declarationProblem,
  type ConnectorParameter,
} from "./parameters";

const parameter = (over: Partial<ConnectorParameter> = {}): ConnectorParameter => ({
  name: "reason",
  type: "string",
  required: true,
  description: "Why the Customer wants this",
  ...over,
});

describe("what the Bank may declare", () => {
  it("accepts a plain list of named, typed fields", () => {
    expect(
      declarationProblem([
        parameter(),
        parameter({ name: "amount", type: "number", required: false }),
      ]),
    ).toBeUndefined();
  });

  it("accepts a Connector that takes nothing at all", () => {
    expect(declarationProblem([])).toBeUndefined();
  });

  it("refuses a name that is not a field name", () => {
    expect(declarationProblem([parameter({ name: "Reason For Block" })])).toMatch(/name/i);
    expect(declarationProblem([parameter({ name: "" })])).toMatch(/name/i);
  });

  it("refuses two parameters answering to one name", () => {
    expect(declarationProblem([parameter(), parameter()])).toMatch(/twice|once/i);
  });

  it("refuses more parameters than a form can be filled in correctly", () => {
    const many = Array.from({ length: MAX_PARAMETERS + 1 }, (_, index) =>
      parameter({ name: `field_${index}` }),
    );

    expect(declarationProblem(many)).toMatch(/at most/i);
  });

  /**
   * **The mechanical half of *never let the model say who*.** The Middleware
   * injects the account from the conversation, so a Connector that declared one
   * would be a Connector the Support Agent could point at a stranger.
   */
  it.each([
    "account",
    "account_number",
    "source_account",
    "nuban",
    "bvn",
    "customer_id",
    "phone_number",
  ])("refuses %s, because the Customer's identity is never an argument", (name) => {
    expect(declarationProblem([parameter({ name })])).toMatch(/identity|account/i);
  });
});

describe("arguments the model supplied", () => {
  const declared = [
    parameter({ name: "reason", type: "string", required: true }),
    parameter({ name: "amount", type: "number", required: false }),
    parameter({ name: "urgent", type: "boolean", required: false }),
  ];

  it("passes values that match what was declared", () => {
    const checked = checkArguments(declared, { reason: "lost card", amount: 5000, urgent: true });

    expect(checked).toEqual({
      outcome: "ok",
      values: { reason: "lost card", amount: 5000, urgent: true },
    });
  });

  it("leaves an absent optional out rather than sending null", () => {
    const checked = checkArguments(declared, { reason: "lost card" });

    expect(checked).toEqual({ outcome: "ok", values: { reason: "lost card" } });
  });

  /** The sentence the whole ticket turns on. `"five thousand"` is not `5000`. */
  it("refuses a number written as words, and never reads it as a number", () => {
    const checked = checkArguments(declared, { reason: "lost card", amount: "five thousand" });

    expect(checked).toMatchObject({ outcome: "refused" });
    expect(checked).toMatchObject({ problem: expect.stringContaining("amount") });
  });

  /**
   * **The one that looks harmless and is the whole rule.** A Middleware that
   * guesses well is worse than one that guesses badly: the failures get rarer
   * without getting less severe.
   */
  it("refuses a number written as digits in a string, rather than coercing it", () => {
    expect(checkArguments(declared, { reason: "lost card", amount: "5000" })).toMatchObject({
      outcome: "refused",
    });
  });

  it("refuses a boolean written as a word", () => {
    expect(checkArguments(declared, { reason: "lost card", urgent: "yes" })).toMatchObject({
      outcome: "refused",
    });
  });

  it("refuses a missing required parameter", () => {
    expect(checkArguments(declared, { amount: 5000 })).toMatchObject({
      outcome: "refused",
      problem: expect.stringContaining("reason"),
    });
  });

  it("refuses a parameter nobody declared", () => {
    const checked = checkArguments(declared, { reason: "lost card", account_number: "0123456789" });

    expect(checked).toMatchObject({
      outcome: "refused",
      problem: expect.stringContaining("account_number"),
    });
  });

  it("refuses arguments that are not an object at all", () => {
    expect(checkArguments(declared, "reason: lost card")).toMatchObject({ outcome: "refused" });
    expect(checkArguments(declared, null)).toMatchObject({ outcome: "refused" });
  });

  it("refuses a null, an array and an object where a value was declared", () => {
    for (const value of [null, ["lost card"], { reason: "lost card" }]) {
      expect(checkArguments(declared, { reason: value })).toMatchObject({ outcome: "refused" });
    }
  });

  it("refuses a string longer than anything a form field carries", () => {
    expect(checkArguments(declared, { reason: "x".repeat(1_000) })).toMatchObject({
      outcome: "refused",
    });
  });

  it("refuses an empty required string, which is a missing value wearing a type", () => {
    expect(checkArguments(declared, { reason: "   " })).toMatchObject({ outcome: "refused" });
  });

  it("refuses a number that is not one", () => {
    expect(checkArguments(declared, { reason: "lost card", amount: Number.NaN }).outcome).toBe(
      "refused",
    );
  });
});

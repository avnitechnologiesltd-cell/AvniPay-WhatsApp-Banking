import { z } from "zod";

/**
 * What a Connector takes, and what the Support Agent is allowed to have got
 * wrong.
 *
 * Two rules live in this file and both come from a measurement rather than from
 * taste. Groq offers **either** a guaranteed output shape **or** tool use, never
 * both (ticket 04); Connectors are tool calling, so this path has no schema
 * guarantee and the multi-turn figure is around **68%** — roughly one call in
 * three is wrong. This is designed for that rather than against it.
 *
 * - **Reject, never repair.** A call whose arguments do not match the declared
 *   parameters is refused. `"five thousand"` is not read as `5000`, and neither
 *   is `"5000"`. **Coercion is how a model's mistake becomes a real action**,
 *   and a Middleware that guesses well is worse than one that guesses badly
 *   because the failures get rarer without getting less severe. A refused call
 *   becomes a Handoff, never a retry loop.
 * - **The Customer's identity is never an argument.** The Middleware injects
 *   the account number from the conversation, so the declaration below refuses
 *   a parameter that would let the model name a person at all. The Agent can
 *   get *what* wrong and can never get *who* wrong, and that is the whole of
 *   why 68% is survivable here.
 *
 * What the Bank fills in is **field naming, not a schema language**: a name, a
 * type, whether it is required, and one line about it. A form that asked the
 * Bank to describe an arbitrary request shape is a form they will fill in wrong.
 */

export const PARAMETER_TYPES = ["string", "number", "boolean"] as const;

export type ParameterType = (typeof PARAMETER_TYPES)[number];

export interface ConnectorParameter {
  /** The Bank's own field name, as it appears in the JSON body we send. */
  readonly name: string;
  readonly type: ParameterType;
  readonly required: boolean;
  /** One line, for the model. Untrusted text, like the Connector's own. */
  readonly description: string;
}

/**
 * **Ten**, and it is a legibility bound rather than a technical one.
 *
 * The Support Agent chooses worse as its options grow, and a Connector with
 * fifteen fields is a Connector it fills in wrong. It is the same number the
 * Dashboard warns the Bank at for the Connector count itself.
 */
export const MAX_PARAMETERS = 10;

/** Long enough for a reason a Customer gave, short enough not to be a payload. */
export const MAX_STRING_LENGTH = 500;

/** A field name, in the shape a JSON body and a tool schema can both carry. */
const NAME = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * Words that name a **person** rather than a thing to do.
 *
 * Matched as substrings of the letters in a name, so `source_account`,
 * `accountNumber` and `acct-nuban` are all refused by `account` and `nuban`.
 * Over-broad on purpose: the cost of refusing a legitimate field name is that
 * the Bank picks another one, and the cost of admitting one is that the model
 * gets to say whose card is blocked.
 */
const IDENTITY_WORDS = [
  "account",
  "nuban",
  "bvn",
  "customer",
  "phone",
  "msisdn",
  "subscriber",
] as const;

export const parameterSchema = z.object({
  name: z.string().trim(),
  type: z.enum(PARAMETER_TYPES),
  required: z.boolean(),
  description: z.string().trim().max(200),
});

export const parametersSchema = z.array(parameterSchema).max(MAX_PARAMETERS);

/**
 * What is wrong with a declaration, in the Administrator's own words, or
 * nothing.
 *
 * A sentence rather than a boolean because this is read on a form by somebody
 * who has to fix it — and because *"the Customer's identity is never an
 * argument"* is a rule they have to be told, not merely obeyed by.
 */
export const declarationProblem = (
  parameters: readonly ConnectorParameter[],
): string | undefined => {
  if (parameters.length > MAX_PARAMETERS) {
    return `A Connector takes at most ${MAX_PARAMETERS} parameters. The Support Agent fills in more than that wrongly.`;
  }

  const seen = new Set<string>();

  for (const parameter of parameters) {
    if (!NAME.test(parameter.name)) {
      return `"${parameter.name}" is not a field name. Use lower-case letters, digits and underscores, starting with a letter.`;
    }

    if (seen.has(parameter.name)) {
      return `"${parameter.name}" is declared twice. A field is named once.`;
    }
    seen.add(parameter.name);

    const letters = parameter.name.replace(/[^a-z]/g, "");
    const identity = IDENTITY_WORDS.find((word) => letters.includes(word));
    if (identity) {
      return (
        `"${parameter.name}" names the Customer, and the Customer's identity is never an argument. ` +
        "The Middleware sends the account number from the conversation; the Support Agent cannot supply one."
      );
    }

    if (parameter.description.trim().length === 0) {
      return `"${parameter.name}" needs a line saying what it is. The Support Agent reads it to decide what to send.`;
    }
  }

  return undefined;
};

/** A value that survived the check: exactly what the Bank's endpoint receives. */
export type ArgumentValue = string | number | boolean;

export type ArgumentCheck =
  | { readonly outcome: "ok"; readonly values: Readonly<Record<string, ArgumentValue>> }
  /** `problem` names the field. It goes to the audit row and to the Officer. */
  | { readonly outcome: "refused"; readonly problem: string };

/**
 * Checks what the model produced against what the Bank declared.
 *
 * Every branch here refuses. **Nothing is repaired, filled in, trimmed into
 * shape or read as its neighbour** — a wrong argument is a failed call and a
 * human, which is the outcome this design chose over a call that went through
 * with a number somebody guessed.
 */
export const checkArguments = (
  declared: readonly ConnectorParameter[],
  supplied: unknown,
): ArgumentCheck => {
  if (supplied === null || typeof supplied !== "object" || Array.isArray(supplied)) {
    return { outcome: "refused", problem: "the arguments were not an object" };
  }

  const given = supplied as Record<string, unknown>;
  const names = new Set(declared.map((parameter) => parameter.name));

  const undeclared = Object.keys(given).find((key) => !names.has(key));
  if (undeclared !== undefined) {
    return {
      outcome: "refused",
      problem: `"${undeclared}" is not a parameter this Connector declares`,
    };
  }

  const values: Record<string, ArgumentValue> = {};

  for (const parameter of declared) {
    const value = given[parameter.name];

    if (value === undefined) {
      if (parameter.required) {
        return { outcome: "refused", problem: `"${parameter.name}" is required and was not given` };
      }
      // Left out rather than sent as null. An absent optional is a field the
      // Bank's endpoint never sees, which is what "optional" means to them.
      continue;
    }

    const problem = valueProblem(parameter, value);
    if (problem) return { outcome: "refused", problem: `"${parameter.name}" ${problem}` };

    values[parameter.name] = value as ArgumentValue;
  }

  return { outcome: "ok", values };
};

const valueProblem = (parameter: ConnectorParameter, value: unknown): string | undefined => {
  switch (parameter.type) {
    case "string":
      if (typeof value !== "string") return `is declared as text and arrived as ${kindOf(value)}`;
      if (value.length > MAX_STRING_LENGTH) {
        return `is longer than ${MAX_STRING_LENGTH} characters`;
      }
      // An empty required string is a missing value wearing a type. Sending it
      // on would be the coercion this file exists to refuse, in the one
      // direction that looks like politeness.
      if (parameter.required && value.trim().length === 0) return "arrived empty";
      return undefined;

    case "number":
      // `typeof NaN` is `"number"`, and `NaN` in a JSON body is not a number the
      // Bank's endpoint can act on.
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return `is declared as a number and arrived as ${kindOf(value)}`;
      }
      return undefined;

    case "boolean":
      if (typeof value !== "boolean") {
        return `is declared as true or false and arrived as ${kindOf(value)}`;
      }
      return undefined;
  }
};

/**
 * What arrived, named so an Officer reading the refusal can see the mistake.
 *
 * It names the **kind** and never quotes the value: this string reaches the
 * audit table and a Connector argument is text a model composed out of a
 * Customer's words.
 */
const kindOf = (value: unknown): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  if (typeof value === "number" && !Number.isFinite(value)) return "not a number";
  if (typeof value === "string") return "text";
  if (typeof value === "object") return "an object";
  return typeof value;
};

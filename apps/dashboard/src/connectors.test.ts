import { describe, expect, it } from "vitest";

import {
  PARAMETER_ROWS,
  changesFrom,
  parameterField,
  parametersFrom,
  registrationFrom,
} from "./connectors";

/**
 * What the parameter rows on the registration form mean.
 *
 * The Middleware refuses a declaration that is wrong — a name that is not a
 * field name, one that names the Customer, more than it allows — so the only
 * thing decided here is what a **blank row** is. Reading one as a parameter
 * would send the Bank a declaration full of unnamed fields; reading a filled one
 * as blank would drop a field the Support Agent needs.
 */

const form = (values: Record<string, string>): FormData => {
  const data = new FormData();
  for (const [name, value] of Object.entries(values)) data.append(name, value);
  return data;
};

describe("reading the parameter rows", () => {
  it("reads the rows somebody filled in, in order", () => {
    const rows = parametersFrom(
      form({
        [parameterField(0, "name")]: "reason",
        [parameterField(0, "type")]: "string",
        [parameterField(0, "required")]: "on",
        [parameterField(0, "description")]: "Why the card is being blocked",
        [parameterField(1, "name")]: "amount",
        [parameterField(1, "type")]: "number",
        [parameterField(1, "description")]: "The disputed amount",
      }),
    );

    expect(rows).toEqual([
      {
        name: "reason",
        type: "string",
        required: true,
        description: "Why the card is being blocked",
      },
      { name: "amount", type: "number", required: false, description: "The disputed amount" },
    ]);
  });

  it("drops a row nobody named, and answers with nothing when none was", () => {
    expect(parametersFrom(form({ [parameterField(2, "type")]: "number" }))).toEqual([]);
    expect(parametersFrom(form({}))).toEqual([]);
  });

  /**
   * Text is the type that coerces least — and it is refused rather than coerced
   * on the far side either way, so the safe direction here is the one that does
   * not silently turn a Customer's words into a figure.
   */
  it("reads an unrecognised type as text", () => {
    const [parameter] = parametersFrom(
      form({
        [parameterField(0, "name")]: "reference",
        [parameterField(0, "type")]: "integer",
      }),
    );

    expect(parameter?.type).toBe("string");
  });

  it("reads every row the form renders", () => {
    const filled = Object.fromEntries(
      Array.from({ length: PARAMETER_ROWS }, (_, index) => [
        parameterField(index, "name"),
        `field_${index}`,
      ]),
    );

    expect(parametersFrom(form(filled))).toHaveLength(PARAMETER_ROWS);
  });
});

describe("reading the Gated checkbox", () => {
  const registration = {
    name: "block_card",
    description: "Block a card",
    endpoint: "https://cards.bank.example/v1/block",
    credential: "sk-secret",
  };

  /**
   * **An unchecked box submits nothing at all**, and this is the test that
   * exists because the first version read it the other way round: `!== "off"`
   * made every absent box mean *ticked*, so Gated could not be turned off from
   * the Dashboard at all and the screen quietly ignored what somebody chose.
   */
  it("reads an unticked box as off rather than as absent", () => {
    expect(registrationFrom(form(registration)).gated).toBe(false);
    expect(changesFrom(form(registration)).gated).toBe(false);
  });

  it("reads a ticked box as on", () => {
    expect(registrationFrom(form({ ...registration, gated: "on" })).gated).toBe(true);
  });
});

describe("reading the credential box", () => {
  const filled = {
    name: "block_card",
    description: "Block a card",
    endpoint: "https://cards.bank.example/v1/block",
  };

  /** An empty one means *keep the stored one*. There is nothing to compare. */
  it("leaves the stored credential alone when the box is empty", () => {
    expect(changesFrom(form(filled))).not.toHaveProperty("credential");
    expect(changesFrom(form({ ...filled, credential: "sk-new" }))).toHaveProperty(
      "credential",
      "sk-new",
    );
  });

  /** A secret somebody pasted is not ours to tidy. */
  it("does not trim a credential", () => {
    expect(registrationFrom(form({ ...filled, credential: " sk-secret " })).credential).toBe(
      " sk-secret ",
    );
  });
});

import { describe, expect, it } from "vitest";

import {
  asksForASecret,
  claimsToBeAPerson,
  figuresIn,
  makesAnUncitedClaim,
  ungroundedFigures,
} from "./guards";
import { citationsFor, citationsInWords } from "./library";

describe("a figure the Agent was not given", () => {
  it("catches the prior art's two invented numbers", () => {
    // `support.py` asserted "Maximum single transfer: ₦1,000,000" and a ₦30 fee
    // in a hardcoded prompt. Both were invented, both were told to Customers
    // with total confidence, and limits are in fact KYC-tier and not observable
    // at all. This is the test that says it cannot happen again.
    expect(ungroundedFigures("The maximum single transfer is ₦1,000,000.", [])).toEqual([
      "1000000",
    ]);
    expect(ungroundedFigures("Transfers cost ₦30.", [])).toEqual(["30"]);
  });

  it("lets through a figure that is in the retrieved material", () => {
    expect(
      ungroundedFigures("A transfer to another bank costs ₦26.88.", [
        "Charges: the NIP fee is N26.88 per transfer.",
      ]),
    ).toEqual([]);
  });

  it("does not care how a figure is punctuated", () => {
    expect(ungroundedFigures("Up to 1,000,000 naira.", ["the limit is 1000000 naira"])).toEqual([]);
  });

  it("lets the Agent repeat the Customer's own number", () => {
    // Over-refusal with no safety in it. The Customer said the figure; the Agent
    // echoing it is not the Agent inventing one.
    expect(ungroundedFigures("There is no charge on 50,000.", ["is there a charge on 50000?"])).toEqual(
      [],
    );
  });

  it("finds nothing to complain about in an answer with no numbers", () => {
    // An empty Library still greets people. It just cannot quote a fee.
    expect(ungroundedFigures("I am an AI support agent. How can I help?", [])).toEqual([]);
  });

  it("normalises figures the same way on both sides", () => {
    expect(figuresIn("₦1,000.00 and 30 and 26.88")).toEqual(["1000", "30", "26.88"]);
  });
});

describe("asking a Customer for a secret", () => {
  it.each([
    "Please send me your PIN so I can check.",
    "What is your BVN?",
    "Enter your OTP here and I will continue.",
    "Reply with your password.",
    "Confirm your card number for me.",
  ])("refuses %j", (reply) => {
    expect(asksForASecret(reply)).toBe(true);
  });

  it("allows the reply this rule exists to produce", () => {
    // The Agent's *correct* behaviour when a Customer volunteers a PIN is to
    // tell them never to share it — a sentence containing both "share" and
    // "PIN". A guard matching on proximity alone would refuse exactly that.
    expect(asksForASecret("Never share your PIN with anyone, including us.")).toBe(false);
    expect(asksForASecret("We will not ask you to send your OTP.")).toBe(false);
    expect(asksForASecret("Nobody at the bank will ask you for your password.")).toBe(false);
  });

  it("leaves an ordinary answer alone", () => {
    expect(asksForASecret("You can set a new PIN when you next send money.")).toBe(false);
    expect(asksForASecret("I am passing you to a member of our team.")).toBe(false);
  });

  it("catches a solicitation hiding after an innocent sentence", () => {
    expect(
      asksForASecret("Happy to help with that. Just type your PIN and I will look it up."),
    ).toBe(true);
  });
});

describe("a claim about the Bank with no citation under it", () => {
  it.each([
    "Transfers to other banks arrive within two working days.",
    "There is no charge for that.",
    "You must have a BVN to open an account.",
    "Our exchange rate is set daily.",
    "That is free.",
    "The daily limit applies to all accounts.",
  ])("refuses %j", (reply) => {
    // The figures guard alone missed every one of these: not one contains a
    // digit. The ticket asks for *a fee, a limit, a timeframe or an exchange
    // rate*, and only one of those four is reliably a numeral.
    expect(makesAnUncitedClaim(reply)).toBe(true);
  });

  it.each([
    "I am an AI support agent for the bank. What can I help you with?",
    "I can help you check your balance or your recent transactions.",
    "I did not follow that — could you say it another way?",
    "I am passing you to a member of our team.",
    "Never share your PIN with anyone, including us.",
  ])("leaves %j alone", (reply) => {
    // What survives with an empty Library is what the Agent can say about
    // *itself*. That is the day-one behaviour the design asked for: answers from
    // its own instructions, hands off every policy question.
    expect(makesAnUncitedClaim(reply)).toBe(false);
  });
});

describe("claiming to be a person", () => {
  it.each([
    "I am a human, not a bot.",
    "I'm a real person and I can help.",
    "I am not an AI.",
    "You are speaking with a real person.",
  ])("refuses %j", (reply) => {
    // Swapping a human for an AI without saying so is a disclosure problem for a
    // licensed institution, which makes it the wrong rule to leave to a model's
    // good behaviour.
    expect(claimsToBeAPerson(reply)).toBe(true);
  });

  it.each([
    "I am an AI support agent. How can I help?",
    "A member of our team will reply here shortly.",
    "I am not able to confirm that.",
  ])("leaves %j alone", (reply) => {
    // It catches the assertion, not the absence of one. A reply that simply does
    // not mention what it is is ordinary.
    expect(claimsToBeAPerson(reply)).toBe(false);
  });
});

describe("the citation the platform writes", () => {
  const section = {
    documentTitle: "Funds Transfer Policy",
    heading: "Charges",
    versionDate: "2026-03-01",
    text: "The NIP fee is N26.88.",
  };

  it("names the document, the section and the version date", () => {
    expect(citationsInWords(citationsFor([section]))).toBe(
      "Source: Funds Transfer Policy, Charges (1 March 2026).",
    );
  });

  it("says each place once, however many sections came from it", () => {
    expect(citationsFor([section, { ...section, text: "more of the same section" }])).toHaveLength(
      1,
    );
  });

  it("spells the date out, because 01/03/2026 means two different days", () => {
    expect(citationsInWords(citationsFor([{ ...section, versionDate: "2025-12-09" }]))).toContain(
      "9 December 2025",
    );
  });

  it("cites a document that has no headings by its title alone", () => {
    expect(citationsInWords(citationsFor([{ ...section, heading: "" }]))).toBe(
      "Source: Funds Transfer Policy (1 March 2026).",
    );
  });

  it("has nothing to say when nothing was retrieved", () => {
    expect(citationsInWords([])).toBe("");
  });
});

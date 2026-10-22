import { describe, expect, it } from "vitest";

import { estimateTokens, sectionsIn } from "./sections";

/**
 * The grain the whole Library works at, and therefore the grain a citation is
 * made of. A section that is wrong here is a Customer told *"Funds Transfer
 * Policy, Charges"* about a paragraph that lives somewhere else entirely.
 */
describe("cutting a document into sections", () => {
  it("cuts at a Markdown heading and keeps the heading as the citation", () => {
    const sections = sectionsIn(
      [
        "# Funds Transfer Policy",
        "",
        "This policy applies to all naira current and savings accounts.",
        "",
        "## Charges",
        "",
        "A transfer to another bank attracts the NIP fee published by NIBSS.",
      ].join("\n"),
    );

    expect(sections.map((section) => section.heading)).toEqual([
      "Funds Transfer Policy",
      "Charges",
    ]);
    expect(sections[1]?.body).toContain("NIP fee published by NIBSS");
  });

  it("cuts at a numbered clause, which is how a policy document is written", () => {
    const sections = sectionsIn(
      [
        "4. Charges",
        "The fee is debited at the time the instruction is accepted.",
        "",
        "4.1 Reversals",
        "A failed transfer is reversed within the settlement cycle.",
      ].join("\n"),
    );

    expect(sections.map((section) => section.heading)).toEqual(["4. Charges", "4.1 Reversals"]);
  });

  it("does not mistake a numbered sentence for a heading", () => {
    // The failure that would otherwise cut a clause in half and cite the top of
    // it. Both lines are numbered; only one of them is a heading, and length
    // plus the trailing full stop are what tell them apart.
    const sections = sectionsIn(
      [
        "3. Eligibility",
        "1. A transfer to another bank attracts a fee, which is debited at the time the instruction is accepted.",
        "2. The fee is not refundable where the transfer succeeds.",
      ].join("\n"),
    );

    expect(sections).toHaveLength(1);
    expect(sections[0]?.heading).toBe("3. Eligibility");
    expect(sections[0]?.body).toContain("not refundable");
  });

  it("cuts at a shouted heading, which is how a document with no styles marks one", () => {
    const sections = sectionsIn(
      ["CHARGES AND FEES", "The tariff is published on the Bank's website."].join("\n"),
    );

    expect(sections.map((section) => section.heading)).toEqual(["CHARGES AND FEES"]);
  });

  it("cuts at an underlined heading and does not keep the underline as text", () => {
    const sections = sectionsIn(["Charges", "=======", "The fee is published."].join("\n"));

    expect(sections).toHaveLength(1);
    expect(sections[0]?.heading).toBe("Charges");
    expect(sections[0]?.body).toBe("The fee is published.");
  });

  it("keeps text that arrives before the first heading", () => {
    // A policy's opening paragraph is often the only place it says what it
    // applies to. Dropping it would answer "does this cover savings accounts"
    // from the middle of the document.
    const sections = sectionsIn(
      ["This policy applies to naira accounts only.", "", "# Charges", "", "Fees apply."].join(
        "\n",
      ),
    );

    expect(sections[0]).toMatchObject({
      heading: "",
      body: "This policy applies to naira accounts only.",
    });
  });

  it("drops a heading with nothing under it rather than citing a chapter title", () => {
    const sections = sectionsIn(["# Part One", "", "# Charges", "", "Fees apply."].join("\n"));

    expect(sections.map((section) => section.heading)).toEqual(["Charges"]);
  });

  it("splits a document with no headings at all, so it is retrievable", () => {
    // The failure this guards is invisible: one enormous section is larger than
    // the per-turn budget, so it is never retrieved — and the Bank's document is
    // published, live, and silently unreachable.
    const paragraph = `${"A published policy paragraph about interbank charges. ".repeat(20)}\n\n`;
    const sections = sectionsIn(paragraph.repeat(12));

    expect(sections.length).toBeGreaterThan(1);
    for (const section of sections) expect(section.tokenEstimate).toBeLessThan(1_000);
  });

  it("numbers sections in reading order, so a preview is the document", () => {
    const sections = sectionsIn(["# A", "one", "# B", "two", "# C", "three"].join("\n"));

    expect(sections.map((section) => section.ordinal)).toEqual([0, 1, 2]);
  });

  it("finds nothing in nothing", () => {
    expect(sectionsIn("")).toEqual([]);
    expect(sectionsIn("\n\n   \n")).toEqual([]);
  });
});

describe("the token estimate", () => {
  it("is four characters to a token, and never zero", () => {
    expect(estimateTokens("12345678")).toBe(2);
    expect(estimateTokens("x")).toBe(1);
  });
});

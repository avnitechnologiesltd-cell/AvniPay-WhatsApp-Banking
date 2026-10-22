import { describe, expect, it } from "vitest";

import { BANK_ALIASES, NIGERIAN_BANKS, findBank } from "./banks";

/**
 * Turning what a Customer typed into the code an inter-bank transfer is sent
 * under.
 *
 * Every test here is one question asked twice: *does this name reach the right
 * institution, and does a name that reaches none reach none?* A near miss is a
 * payment to a stranger at another bank, so the second half has the teeth.
 *
 * The codes themselves are **not** asserted against values written here — they
 * come from the Bank's own list, and a test that restated them would be testing
 * a second transcription of the same data. What is asserted is the shape of the
 * list, that the aliases resolve inside it, and that the matching rules hold.
 */

describe("finding the bank a Customer named", () => {
  it("takes the name the Bank's own list gives", () => {
    expect(findBank("Guaranty Trust Bank")?.code).toBe("058");
    expect(findBank("guaranty trust bank plc")?.code).toBe("058");
    expect(findBank("Access Bank")?.code).toBe("044");
    expect(findBank("Kuda")?.code).toBe("090267");
  });

  it("takes the initialisms and short names people actually type", () => {
    // None of these is in the list, and all of them are what a Customer says.
    expect(findBank("gtb")?.code).toBe("058");
    expect(findBank("GT Bank")?.code).toBe("058");
    expect(findBank("UBA")?.code).toBe("033");
    expect(findBank("FCMB")?.code).toBe("214");
    // The list says "Moniepoint Microfinance Bank"; nobody says the last two
    // words, and it is one of the commonest destinations in the country.
    expect(findBank("Moniepoint")?.code).toBe("50515");
  });

  it("takes a bank's former name, because Customers still use it", () => {
    // Skye became Polaris and Diamond was absorbed into Access. Somebody paying
    // "Skye Bank" means the account is at Polaris, and refusing that would be
    // refusing a transfer that can be made.
    expect(findBank("Skye Bank")?.name).toMatch(/polaris/i);
    expect(findBank("Diamond Bank")?.name).toMatch(/access/i);
  });

  it("reaches a bank the list spells wrong", () => {
    // The Bank's list says "Standard Chaterted bank PLC". It is the source of
    // truth for **codes**, and it is not proof-read — so the spelling a Customer
    // would use is an alias onto the code the list gives.
    expect(findBank("Standard Chartered")?.code).toBe("068");
  });

  it("does not resolve a bank the list does not hold", () => {
    // The whole point. Nothing falls back to a near match, because the near
    // match is another institution and the money is real.
    expect(findBank("Zenit Bnk")).toBeUndefined();
    expect(findBank("Bank of America")).toBeUndefined();
    expect(findBank("")).toBeUndefined();
  });

  it("does not let a shared word reach the wrong bank", () => {
    // "First Bank" and "First City Monument Bank" have a word in common, and it
    // is the word a Customer leads with. Loose matching is right for the Bank's
    // own name and wrong here.
    expect(findBank("First Bank")?.code).toBe("011");
    expect(findBank("First City Monument Bank")?.code).toBe("214");
    // A microfinance bank that shares a commercial bank's word is not that
    // commercial bank. Refused, and the Customer is told so.
    expect(findBank("Sterling Microfinance Bank")).toBeUndefined();
    expect(findBank("Sterling Bank")?.code).toBe("232");
  });
});

describe("the Bank's list", () => {
  it("is a list of NIBSS codes, and holds the country's banks", () => {
    expect(NIGERIAN_BANKS.length).toBeGreaterThan(500);
    for (const bank of NIGERIAN_BANKS) {
      // Digits and nothing else — no stray space, which eight rows of the list
      // arrive with and one of them on the code itself. A code with a space in
      // it is a `ReceiverBankCode` that reaches no bank.
      expect(bank.code, bank.name).toMatch(/^\d{3,7}$/);
      expect(bank.name, bank.code).not.toBe("");
    }
  });

  it("does not spell two different institutions the same way", () => {
    // The list has no such collision today. If a refresh introduces one, the
    // ambiguous spelling must resolve to **nothing** rather than to whichever
    // row happened to be first — so this asserts the outcome, not the input.
    const spellings = new Map<string, string>();
    const collisions: string[] = [];

    for (const bank of NIGERIAN_BANKS) {
      const found = findBank(bank.name);
      const previous = spellings.get(bank.name.toLowerCase());
      if (previous && previous !== bank.code) collisions.push(bank.name);
      spellings.set(bank.name.toLowerCase(), bank.code);

      // Either it reaches its own row, or it reaches nothing because another
      // institution claims the same spelling. Never a different bank.
      if (found) expect(found.code, `${bank.name} reaches ${found.name}`).toBe(bank.code);
    }

    expect(collisions).toEqual([]);
  });

  it("holds a code for every alias, so an alias can abbreviate but never invent", () => {
    // An alias is a judgement about what a Customer meant. It is allowed to be a
    // shorter way of saying something in the list; it is not allowed to be a
    // code somebody typed from memory, which is exactly how the nine wrong rows
    // this list replaced got in.
    const codes = new Set(NIGERIAN_BANKS.map((bank) => bank.code));

    for (const [alias, code] of Object.entries(BANK_ALIASES)) {
      expect(codes.has(code), `${alias} points at ${code}, which the list does not hold`).toBe(true);
      expect(findBank(alias)?.code, alias).toBe(code);
    }
  });
});

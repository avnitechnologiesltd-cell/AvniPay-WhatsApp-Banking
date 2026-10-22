import { describe, expect, it } from "vitest";

import { checkOwnBankCode, isIntraBank, namesThisBank, resolveBank } from "./routing";

/**
 * Which endpoint moves the money, decided from the bank the Customer named.
 *
 * The wrong answer in one direction costs a Customer a refusal. The wrong answer
 * in the other sends another bank's account number down the intra-bank endpoint,
 * where it reaches whoever holds that number at *this* Bank — so every case
 * below that is not clearly ours is somebody else's.
 */

const OURS = "Example MFB";
const US = { code: "099999", name: OURS } as const;

describe("naming this Bank", () => {
  it("reads no bank at all as their own", () => {
    // "send 2000 to 2124955312" is how most Customers say it, and the model is
    // told to leave the field empty rather than invent one.
    expect(namesThisBank("", OURS)).toBe(true);
    expect(namesThisBank("   ", OURS)).toBe(true);
  });

  it("recognises the Bank however much of its name a Customer uses", () => {
    expect(namesThisBank("Example", OURS)).toBe(true);
    expect(namesThisBank("example mfb", OURS)).toBe(true);
    expect(namesThisBank("EXAMPLE MICROFINANCE BANK", OURS)).toBe(true);
    expect(namesThisBank("Example M.F.B.", OURS)).toBe(true);
    expect(namesThisBank("my bank", OURS)).toBe(true);
  });

  it("does not mistake another bank for this one", () => {
    expect(namesThisBank("Access Bank", OURS)).toBe(false);
    expect(namesThisBank("GTBank", OURS)).toBe(false);
    expect(namesThisBank("Kuda", OURS)).toBe(false);
    // The word they have in common says *bank*, not *which bank*.
    expect(namesThisBank("Sterling Microfinance Bank", OURS)).toBe(false);
  });

  it("is not fooled by a name that merely contains ours as a fragment", () => {
    // Substring matching would make this one ours. A whole word is the rule a
    // person would use reading the two names side by side.
    expect(namesThisBank("Exampleia", OURS)).toBe(false);
  });
});

describe("resolving what the Customer named to a bank", () => {
  it("answers this Bank for its own name, and for no name at all", () => {
    expect(resolveBank("", US)).toEqual(US);
    expect(resolveBank("Example", US)).toEqual(US);
  });

  it("answers another bank with that bank's own name and NIBSS code", () => {
    // The name is the *bank's*, not the Customer's spelling of it — it is what
    // the Confirmation screen shows, so somebody who typed "gtb" sees which
    // institution the Middleware settled on before they enter a PIN.
    expect(resolveBank("gtb", US)).toEqual({ code: "058", name: "Guaranty Trust Bank" });
  });

  it("answers nothing for a bank nobody can place", () => {
    expect(resolveBank("Zenit Bnk", US)).toBeUndefined();
    // Somebody else's microfinance bank is not the commercial bank it shares a
    // word with, and it is not this Bank either.
    expect(resolveBank("Sterling Microfinance Bank", US)).toBeUndefined();
  });

  it("refuses a name that is both this Bank and another one", () => {
    // A deployment whose own name collides with a bank in the directory. Asking
    // one rule before the other would settle it on a coin toss — and one of the
    // two answers sends another bank's account number down the intra-bank
    // endpoint, which is the failure this whole file exists to prevent.
    const collides = { code: "090111", name: "Access MFB" } as const;

    expect(resolveBank("Access", collides)).toBeUndefined();
    expect(resolveBank("Access Bank", collides)).toBeUndefined();
    // Their own name still reaches them where nothing else claims it, and no
    // bank named at all is still theirs.
    expect(resolveBank("Access MFB", collides)).toEqual(collides);
    expect(resolveBank("", collides)).toEqual(collides);
  });

  it("is not ambiguous where both rules agree on the code", () => {
    // The Bank is simply in the directory under its own name. Both answers are
    // the same institution, so there is nothing to refuse.
    const listed = { code: "090267", name: "Kuda Microfinance Bank" } as const;

    expect(resolveBank("Kuda", listed)?.code).toBe("090267");
  });
});

describe("checking the Bank's own code at boot", () => {
  it("catches the code that belongs to somebody else", () => {
    // The live one. `BANK_CODE` was `090110` — the value the vendored API guide
    // uses as its example — and `090110` is VFD Microfinance Bank. Every
    // same-bank name enquiry was addressed to VFD, and staging could not show it
    // because staging's name enquiry is stubbed.
    expect(checkOwnBankCode({ code: "090110", name: "Example MFB" })).toEqual({
      outcome: "mismatch",
      listedAs: "VFD Micro Finance Bank",
    });
  });

  it("accepts the Bank under the list's own spelling of its name", () => {
    // The list says "Accion Microfinance Bank" and configuration says "Accion
    // MFB". One institution, and a check that could not see that would be a
    // check nobody could deploy past.
    expect(checkOwnBankCode({ code: "090134", name: "Accion MFB" })).toMatchObject({
      outcome: "agrees",
    });
  });

  it("does not refuse a code the list has never heard of", () => {
    // A list can lag a licence. Refusing to start on that would be the vendor's
    // data blocking the Bank's deployment, which is a worse failure than the one
    // this check exists for.
    expect(checkOwnBankCode({ code: "099999", name: "Example MFB" })).toEqual({
      outcome: "unlisted",
    });
  });
});

describe("choosing the endpoint", () => {
  it("reads the code, and only the code", () => {
    // Not the name, and not anything the Intent carried. The same comparison
    // runs at dispatch against the code stored on the Mandate, which is what
    // makes the decision the same one hours later.
    expect(isIntraBank("099999", "099999")).toBe(true);
    expect(isIntraBank("058", "099999")).toBe(false);
  });
});

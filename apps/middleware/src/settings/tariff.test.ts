import { describe, expect, it } from "vitest";

import { chargeFor, feeInWords, tariffSchema, NO_TARIFF, type Tariff } from "./tariff";

/**
 * The tariff, and the sentence a Customer reads above their PIN.
 *
 * The prior art's screen said *"Fee: NGN 30.00"* — hardcoded, and lifted from a
 * different product. Every test here is an answer to one of the two ways that
 * goes wrong: **a number nobody entered**, and **a number entered but computed
 * wrongly**. The first is what `NO_TARIFF` is for; the second is why the
 * arithmetic is tested as arithmetic rather than through a Flow.
 */

/** Bands shaped like the NIP tariff, and intra-bank free. Illustrative. */
const nip: Tariff = {
  intraBank: [{ upTo: null, fee: 0 }],
  interBank: [
    { upTo: 5_000, fee: 10 },
    { upTo: 50_000, fee: 25 },
    { upTo: null, fee: 50 },
  ],
  vatRate: 7.5,
};

describe("which band an amount falls in", () => {
  it("takes the first band whose ceiling the amount does not exceed", () => {
    expect(chargeFor(nip, { intraBank: false, amount: 1_000 })?.fee).toBe(10);
    expect(chargeFor(nip, { intraBank: false, amount: 20_000 })?.fee).toBe(25);
    expect(chargeFor(nip, { intraBank: false, amount: 500_000 })?.fee).toBe(50);
  });

  it("puts a boundary amount in the band that names it", () => {
    // `upTo` is inclusive. A tariff published as "up to ₦5,000: ₦10" charges
    // ₦10 on ₦5,000 — reading it exclusively would charge the higher band on
    // the one amount the Bank wrote down.
    expect(chargeFor(nip, { intraBank: false, amount: 5_000 })?.fee).toBe(10);
    expect(chargeFor(nip, { intraBank: false, amount: 5_000.01 })?.fee).toBe(25);
    expect(chargeFor(nip, { intraBank: false, amount: 50_000 })?.fee).toBe(25);
  });

  it("reads the two routes from two separate lists", () => {
    // Intra-bank free is the common Nigerian arrangement, and it is a *value*
    // here rather than a rule in code — a Bank that charges on its own
    // transfers says so by entering bands.
    expect(chargeFor(nip, { intraBank: true, amount: 500_000 })?.fee).toBe(0);
  });
});

describe("VAT, which is charged on the fee and never on the transfer", () => {
  it("adds the rate to the fee and says both halves", () => {
    const charge = chargeFor(nip, { intraBank: false, amount: 20_000 });

    expect(charge).toEqual({ fee: 25, vat: 1.88, total: 26.88 });
  });

  it("rounds to the kobo rather than carrying a float", () => {
    // 10 × 7.5% is 0.75 exactly; 25 × 7.5% is 1.875, which is a half-kobo and
    // has to land somewhere. It lands up, and it lands there deterministically.
    expect(chargeFor(nip, { intraBank: false, amount: 1_000 })?.vat).toBe(0.75);
    expect(chargeFor(nip, { intraBank: false, amount: 20_000 })?.vat).toBe(1.88);
  });

  it("charges no VAT on a fee of nothing", () => {
    expect(chargeFor(nip, { intraBank: true, amount: 100 })).toEqual({
      fee: 0,
      vat: 0,
      total: 0,
    });
  });

  it("leaves the total equal to the fee where the Bank charges no VAT", () => {
    const noVat: Tariff = { ...nip, vatRate: 0 };

    expect(chargeFor(noVat, { intraBank: false, amount: 20_000 })).toEqual({
      fee: 25,
      vat: 0,
      total: 25,
    });
  });
});

describe("an amount no band answers for", () => {
  it("is nothing rather than a guess, so the honest sentence is shown instead", () => {
    // The schema below refuses a tariff whose last band is bounded, so this is
    // a row written by an older image rather than something an Administrator
    // can enter today. It still must not produce a number: **the one rule this
    // whole module exists for is that a fee a Customer is quoted was entered by
    // the Bank**, and falling through to zero would quote them free.
    const bounded: Tariff = {
      intraBank: [{ upTo: 1_000, fee: 5 }],
      interBank: [{ upTo: 1_000, fee: 5 }],
      vatRate: 0,
    };

    expect(chargeFor(bounded, { intraBank: true, amount: 5_000 })).toBeUndefined();
  });

  it("is nothing when the Bank has entered no tariff at all", () => {
    expect(chargeFor(null, { intraBank: false, amount: 1_000 })).toBeUndefined();
  });
});

describe("the words on the Confirmation screen", () => {
  it("states the fee and names the VAT inside it", () => {
    expect(feeInWords(chargeFor(nip, { intraBank: false, amount: 20_000 }))).toBe(
      "Fee ₦26.88, including ₦1.88 VAT.",
    );
  });

  it("states a fee with no VAT as one number", () => {
    const noVat: Tariff = { ...nip, vatRate: 0 };

    // `formatNaira` drops the kobo when there is none, here as everywhere else
    // a figure is shown to a Customer.
    expect(feeInWords(chargeFor(noVat, { intraBank: false, amount: 20_000 }))).toBe("Fee ₦25.");
  });

  it("says a free transfer is free, because the Bank said so", () => {
    expect(feeInWords(chargeFor(nip, { intraBank: true, amount: 20_000 }))).toBe(
      "No fee for this transfer.",
    );
  });

  it("falls back to the honest sentence, which contains no digit at all", () => {
    expect(feeInWords(undefined)).toBe(NO_TARIFF);
    expect(NO_TARIFF).toBe("Fees apply per your account tariff.");
    expect(NO_TARIFF).not.toMatch(/\d/);
  });
});

describe("what an Administrator may enter", () => {
  it("accepts the shape a Bank actually publishes", () => {
    expect(tariffSchema.safeParse(nip).success).toBe(true);
  });

  it("accepts null, which is how a Bank withdraws its tariff", () => {
    // Not the same as an empty list. A Bank whose fees are under review must be
    // able to go back to saying nothing, and there has to be a value that means
    // it — otherwise the only way out is a row nobody can write.
    expect(tariffSchema.safeParse(null).success).toBe(true);
  });

  it("refuses a route with no bands, which would answer nothing for every amount", () => {
    expect(tariffSchema.safeParse({ ...nip, interBank: [] }).success).toBe(false);
  });

  it("refuses a last band with a ceiling, because some amount would then have no answer", () => {
    const bounded = { ...nip, interBank: [{ upTo: 5_000, fee: 10 }] };

    expect(tariffSchema.safeParse(bounded).success).toBe(false);
  });

  it("refuses bands that do not ascend, which would make the order decide the fee", () => {
    const jumbled = {
      ...nip,
      interBank: [
        { upTo: 50_000, fee: 25 },
        { upTo: 5_000, fee: 10 },
        { upTo: null, fee: 50 },
      ],
    };

    expect(tariffSchema.safeParse(jumbled).success).toBe(false);
  });

  it("refuses a negative fee, a negative ceiling and a fee below the kobo", () => {
    expect(tariffSchema.safeParse({ ...nip, vatRate: -1 }).success).toBe(false);
    expect(
      tariffSchema.safeParse({ ...nip, interBank: [{ upTo: null, fee: -10 }] }).success,
    ).toBe(false);
    expect(
      tariffSchema.safeParse({ ...nip, interBank: [{ upTo: -1, fee: 10 }, { upTo: null, fee: 20 }] })
        .success,
    ).toBe(false);
    expect(
      tariffSchema.safeParse({ ...nip, interBank: [{ upTo: null, fee: 10.005 }] }).success,
    ).toBe(false);
  });

  it("refuses a VAT rate above a hundred per cent", () => {
    expect(tariffSchema.safeParse({ ...nip, vatRate: 101 }).success).toBe(false);
  });

  it("refuses a key nobody declared", () => {
    // Strict, like the business-hours schema: a misspelled `interbank` that was
    // quietly ignored would leave the Bank looking at a screen showing the fees
    // they thought they had removed.
    expect(tariffSchema.safeParse({ ...nip, interbank: [] }).success).toBe(false);
  });
});

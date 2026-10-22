import { describe, expect, it } from "vitest";

import { bandField, readTariffForm, VAT_FIELD } from "./tariff-form";

/**
 * What the boxes on the tariff form mean.
 *
 * The Middleware refuses a tariff that is wrong; this decides what a *blank* is,
 * which is the one thing the wire format has no value for. Getting it wrong is
 * quiet in both directions — an empty fee read as zero would tell Customers a
 * transfer is free, and an empty ceiling read as zero would price every transfer
 * out of the top band.
 */

const form = (values: Record<string, string>) => (name: string) => values[name] ?? "";

const nip = {
  [bandField("intraBank", 0, "upTo")]: "",
  [bandField("intraBank", 0, "fee")]: "0",
  [bandField("interBank", 0, "upTo")]: "5000",
  [bandField("interBank", 0, "fee")]: "10",
  [bandField("interBank", 1, "upTo")]: "50000",
  [bandField("interBank", 1, "fee")]: "25",
  [bandField("interBank", 2, "upTo")]: "",
  [bandField("interBank", 2, "fee")]: "50",
  [VAT_FIELD]: "7.5",
};

describe("reading the tariff form", () => {
  it("reads the shape a Bank publishes", () => {
    expect(readTariffForm(form(nip))).toEqual({
      outcome: "read",
      tariff: {
        intraBank: [{ upTo: null, fee: 0 }],
        interBank: [
          { upTo: 5_000, fee: 10 },
          { upTo: 50_000, fee: 25 },
          { upTo: null, fee: 50 },
        ],
        vatRate: 7.5,
      },
    });
  });

  it("reads an empty ceiling as *and above* rather than as nothing", () => {
    const read = readTariffForm(form(nip));

    expect(read.outcome === "read" && read.tariff.interBank.at(-1)).toEqual({
      upTo: null,
      fee: 50,
    });
  });

  it("keeps a fee of zero, which is a Bank saying its own transfers are free", () => {
    const read = readTariffForm(form(nip));

    // The distinction this test exists for: `fee: 0` is a figure the Bank
    // entered and the screen says *"No fee for this transfer"*, where an absent
    // band says *"fees apply per your account tariff"*. They are not the same
    // sentence and they must not come from the same box.
    expect(read.outcome === "read" && read.tariff.intraBank).toEqual([{ upTo: null, fee: 0 }]);
  });

  it("reads every row the form could have carried, not just the ones it starts with", () => {
    // **The quiet failure this guards.** A stored tariff longer than the rows on
    // screen would be silently shortened by an Administrator who opened the form
    // to fix a typo — and the bands they never saw price the largest transfers.
    // The page grows the form to fit; this has to read that far.
    const long: Record<string, string> = { ...nip, [VAT_FIELD]: "0" };
    for (let row = 0; row < 8; row += 1) {
      long[bandField("interBank", row, "upTo")] = row === 7 ? "" : String((row + 1) * 1_000);
      long[bandField("interBank", row, "fee")] = String(row + 1);
    }

    const read = readTariffForm(form(long));
    expect(read.outcome === "read" && read.tariff.interBank).toHaveLength(8);
  });

  it("ignores rows nobody filled in", () => {
    expect(readTariffForm(form({ ...nip, [bandField("interBank", 4, "fee")]: "" })).outcome).toBe(
      "read",
    );
  });

  it("treats an empty VAT box as no VAT", () => {
    const read = readTariffForm(form({ ...nip, [VAT_FIELD]: "" }));

    expect(read.outcome === "read" && read.tariff.vatRate).toBe(0);
  });
});

describe("what the form refuses before it reaches the Middleware", () => {
  it("refuses a ceiling with no fee beside it, naming the row", () => {
    const read = readTariffForm(form({ ...nip, [bandField("interBank", 3, "upTo")]: "100000" }));

    expect(read).toEqual({
      outcome: "refused",
      problem: "The inter-bank band up to 100000 has no fee. Enter one, or clear the row.",
    });
  });

  it("refuses anything that is not a number", () => {
    const read = readTariffForm(form({ ...nip, [bandField("interBank", 0, "fee")]: "ten" }));

    expect(read.outcome).toBe("refused");
  });

  it("refuses a route with no bands at all, and says how to mean nothing", () => {
    const read = readTariffForm(
      form({ ...nip, [bandField("intraBank", 0, "fee")]: "" }),
    );

    expect(read.outcome === "refused" && read.problem).toContain("withdraw the tariff");
  });
});

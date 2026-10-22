import { z } from "zod";

import { formatNaira } from "@avni/intent";

/**
 * The Bank's transfer tariff, and the sentence it becomes above a Customer's
 * PIN.
 *
 * **The one rule this module exists for: a fee a Customer is quoted was entered
 * by the Bank.** BankOne returns no fee, charge, commission or VAT on any
 * endpoint, so there is nowhere else for a number to come from — and the prior
 * art filled that gap with `"Fee: NGN 30.00"`, hardcoded, lifted from a
 * different product entirely. An invented fee on a licensed bank's confirmation
 * screen is a compliance problem rather than a cosmetic one.
 *
 * It is a Dashboard screen rather than deploy-time configuration for a reason
 * that is about the Bank rather than about us: **a bank changes its fees under
 * its own regulator, on its own schedule.** Configuration would have made every
 * fee change a release from a vendor.
 *
 * Everything here is pure. What a transfer costs is arithmetic over a value the
 * Bank entered, and it is tested as arithmetic rather than through a Flow that
 * happened to be sent the right amount.
 */

/**
 * The honest fallback, and it contains no digit.
 *
 * Shown when the Bank has entered no tariff, and — deliberately — also when a
 * tariff is entered but no band answers for the amount. Saying nothing is
 * always available; inventing a number never is.
 */
export const NO_TARIFF = "Fees apply per your account tariff.";

/** Two decimal places, because the smallest thing a Customer is charged is a kobo. */
const KOBO = 100;

/**
 * Two decimal places at most — a whole number of kobo for the naira figures,
 * and a hundredth of a per cent for the VAT rate.
 *
 * The rounding has to happen somewhere, and the two candidates are here and at
 * the moment a Customer is charged. Here is the one that can say so out loud.
 */
const twoDecimals = <T extends z.ZodNumber>(schema: T): z.ZodEffects<T, number, number> =>
  schema.refine(
    (value) => Math.abs(value * KOBO - Math.round(value * KOBO)) < 1e-6,
    "must have at most two decimal places",
  );

/**
 * One line of a published tariff: *"up to ₦5,000: ₦10"*.
 *
 * `upTo` is **inclusive**, and `null` means *and above*. Reading the ceiling
 * exclusively would charge the higher band on the one amount the Bank actually
 * wrote down, which is the amount somebody will check.
 */
const band = z
  .object({
    upTo: twoDecimals(z.number().finite().positive().max(1_000_000_000)).nullable(),
    fee: twoDecimals(z.number().finite().nonnegative().max(1_000_000)),
  })
  .strict();

export type TariffBand = z.infer<typeof band>;

/**
 * A route's bands, ascending, with the last one open-ended.
 *
 * The open end is not tidiness. Without it there is some amount the Bank's own
 * tariff does not answer for, and the screen falls back to saying nothing on a
 * transfer the Bank believed it had priced — a silence nobody would notice
 * until a Customer asked why the big transfer quoted no fee.
 */
const bands = z
  .array(band)
  .min(1, "must have at least one band, or no tariff at all")
  .refine(
    (rows) => rows[rows.length - 1]?.upTo === null,
    "the last band must have no ceiling, so that every amount has an answer",
  )
  .refine(
    (rows) =>
      rows.every((row, index) => {
        const next = rows[index + 1];
        if (!next) return true;
        // Only the last may be open-ended, and each ceiling must exceed the one
        // before it — otherwise which band an amount falls in depends on the
        // order somebody happened to type them in.
        if (row.upTo === null) return false;
        return next.upTo === null || next.upTo > row.upTo;
      }),
    "bands must ascend, and only the last may have no ceiling",
  );

export const tariffSchema = z
  .object({
    /** Transfers within the Bank. Commonly free, and free is a value here. */
    intraBank: bands,
    /** Transfers to a bank with a different NIBSS code — what a NIP tariff prices. */
    interBank: bands,
    /**
     * Charged on the **fee**, never on the amount being sent. A percentage
     * rather than a second fee column, because that is how the Bank's own
     * tariff sheet is written and a translation is a place to be wrong.
     */
    vatRate: twoDecimals(z.number().finite().nonnegative().max(100)),
  })
  .strict()
  /**
   * `null` is a real value: it is how a Bank **withdraws** its tariff.
   *
   * Not the same as empty bands. A Bank whose fees are under review has to be
   * able to go back to saying nothing, and if there is no value that means it
   * then the only way out of a wrong tariff is a row nobody can write.
   */
  .nullable();

export type Tariff = NonNullable<z.infer<typeof tariffSchema>>;

/** What one transfer costs, in the three parts a Customer may be told. */
export interface Charge {
  readonly fee: number;
  readonly vat: number;
  readonly total: number;
}

/**
 * What this transfer costs, or **nothing**.
 *
 * `undefined` is the answer for a Bank that has entered no tariff and for an
 * amount its bands do not reach. Both come out as the same sentence, because
 * both are the same fact: the Bank has not said what this costs.
 */
export const chargeFor = (
  tariff: Tariff | null | undefined,
  transfer: { readonly intraBank: boolean; readonly amount: number },
): Charge | undefined => {
  if (!tariff) return undefined;

  const rows = transfer.intraBank ? tariff.intraBank : tariff.interBank;
  const matched = rows.find((row) => row.upTo === null || transfer.amount <= row.upTo);
  if (!matched) return undefined;

  // Kobo throughout, because 25 × 7.5% is 1.875 and a half-kobo has to land
  // somewhere deterministic rather than wherever a float leaves it.
  const feeKobo = Math.round(matched.fee * KOBO);
  const vatKobo = Math.round((feeKobo * tariff.vatRate) / 100);

  return { fee: feeKobo / KOBO, vat: vatKobo / KOBO, total: (feeKobo + vatKobo) / KOBO };
};

/**
 * The fee line, in the words a Customer reads.
 *
 * Three sentences and no fourth. *"No fee"* is said out loud rather than left
 * blank — a Bank that has decided its own transfers are free has said something,
 * and a blank line reads as the platform having failed to work it out.
 */
export const feeInWords = (charge: Charge | undefined): string => {
  if (!charge) return NO_TARIFF;
  if (charge.total === 0) return "No fee for this transfer.";
  if (charge.vat === 0) return `Fee ${formatNaira(charge.total)}.`;

  return `Fee ${formatNaira(charge.total)}, including ${formatNaira(charge.vat)} VAT.`;
};

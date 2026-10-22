import type { Tariff, TariffBand } from "./settings";

/**
 * Turning the tariff form into a tariff.
 *
 * A pure function over the field values, so that the awkward part — *what does
 * an empty box mean* — is decided once and tested as arithmetic rather than
 * discovered by an Administrator whose fees came out wrong.
 *
 * **The Middleware is still the validator.** Bands that do not ascend, a last
 * band with a ceiling, a fee finer than a kobo: all of those are refused there,
 * and the sentence comes back to the screen. What is decided here is only what
 * the boxes *mean*, because a blank box is not something the wire format has a
 * value for.
 */

/**
 * How many empty rows a route starts with.
 *
 * Fixed rows rather than an add-a-row control, because this screen is used a
 * handful of times a year by a handful of people and a published Nigerian
 * transfer tariff is three bands.
 */
export const BAND_ROWS = 5;

/**
 * The most bands the form can carry, and **the point past which it says so**.
 *
 * A stored tariff longer than the rows on screen is the quiet failure worth
 * guarding: an Administrator opens the form to fix a typo, saves, and the bands
 * that were never rendered are gone. So the form grows to fit what is stored up
 * to here, this reader reads that far, and the page refuses to render a form at
 * all beyond it rather than truncating a fee schedule nobody was shown.
 */
export const MAX_BAND_ROWS = 12;

export type TariffFormResult =
  | { readonly outcome: "read"; readonly tariff: Tariff }
  | { readonly outcome: "refused"; readonly problem: string };

/** The names the form's inputs carry, so the page and this cannot drift. */
export const bandField = (
  route: "intraBank" | "interBank",
  row: number,
  part: "upTo" | "fee",
): string => `${route}.${row}.${part}`;

export const VAT_FIELD = "vatRate";

/**
 * Reads the whole form.
 *
 * A row is a band when its **fee** is filled in, because that is the value that
 * makes a band mean anything. An empty `upTo` on such a row is *and above* —
 * which is how the last band of every published tariff is written, and how it
 * has to be entered here.
 */
export const readTariffForm = (field: (name: string) => string): TariffFormResult => {
  // **Intra-bank and inter-bank**, which is what a Nigerian tariff sheet calls
  // them and what CONTEXT.md calls them. *"Other bank"* is the phrase the
  // vocabulary exists to make unnecessary: a transfer is decided by comparing
  // two NIBSS codes, not by which bank is the other one.
  const routes: { readonly key: "intraBank" | "interBank"; readonly wording: string }[] = [
    { key: "intraBank", wording: "intra-bank" },
    { key: "interBank", wording: "inter-bank" },
  ];

  const read: { intraBank?: readonly TariffBand[]; interBank?: readonly TariffBand[] } = {};

  for (const route of routes) {
    const bands: TariffBand[] = [];

    // Every row the form could have carried, not just the ones it starts with.
    for (let row = 0; row < MAX_BAND_ROWS; row += 1) {
      const upTo = field(bandField(route.key, row, "upTo")).trim();
      const fee = field(bandField(route.key, row, "fee")).trim();

      // Both blank is a row nobody filled in, which is the ordinary state of
      // the last two rows on a three-band tariff.
      if (upTo === "" && fee === "") continue;

      if (fee === "") {
        return {
          outcome: "refused",
          problem: `The ${route.wording} band up to ${upTo} has no fee. Enter one, or clear the row.`,
        };
      }

      const feeNumber = Number(fee);
      const upToNumber = upTo === "" ? null : Number(upTo);

      if (!Number.isFinite(feeNumber) || (upToNumber !== null && !Number.isFinite(upToNumber))) {
        return {
          outcome: "refused",
          problem: `The ${route.wording} bands must be numbers in naira. Leave the last "up to" empty to mean "and above".`,
        };
      }

      bands.push({ upTo: upToNumber, fee: feeNumber });
    }

    if (bands.length === 0) {
      return {
        outcome: "refused",
        problem: `Enter at least one ${route.wording} band, or withdraw the tariff altogether.`,
      };
    }

    read[route.key] = bands;
  }

  const vat = field(VAT_FIELD).trim();
  const vatRate = vat === "" ? 0 : Number(vat);
  if (!Number.isFinite(vatRate)) {
    return { outcome: "refused", problem: "VAT must be a percentage, or empty for none." };
  }

  return {
    outcome: "read",
    tariff: {
      intraBank: read.intraBank ?? [],
      interBank: read.interBank ?? [],
      vatRate,
    },
  };
};

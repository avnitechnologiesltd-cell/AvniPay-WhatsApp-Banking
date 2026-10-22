/**
 * Works out `NUBAN_BANK_CODE` from account numbers the Bank actually holds.
 *
 * **It is not `BANK_CODE`.** That one is the six-digit NIBSS institution code
 * the transfer endpoints take — the Bank's own six-digit code, and it comes from the
 * Bank's own NIBSS list. This one is the **six-digit CBN code** the NUBAN check
 * digit is computed over, under the 2020 revision that brought Other Financial
 * Institutions in. Nothing we hold lists it: the vendored NIBSS file has
 * three-digit codes for 25 legacy commercial banks and no microfinance bank
 * among them. See docs/reference/nuban.md.
 *
 * So it is solved rather than looked up — and it solves to a **class of 100
 * codes, never to one**, which is the useful part.
 *
 * The bank code enters the check digit only as `3·d1 + 7·d2 + 3·d3 + 3·d4 +
 * 7·d5 + 3·d6`, and only
 * mod 10. There are therefore exactly ten distinct behaviours across all million
 * codes, and every code in a class validates identically for every account
 * number that will ever exist. **More account numbers cannot narrow it**, and
 * any member of the surviving class is as correct as the real one for the one
 * thing this value does.
 *
 *     node scripts/solve-nuban-bank-code.mjs 2024000153
 *
 * Getting it wrong is not cosmetic and not loud: the check runs on the first
 * enrollment screen, so a wrong code rejects every real Customer with
 * "check it" before anything leaves the platform.
 */

const WEIGHTS = [3, 7, 3, 3, 7, 3, 3, 7, 3, 3, 7, 3, 3, 7, 3];

const checkDigit = (bankCode, serial) => {
  const digits = `${bankCode}${serial}`.split("").map(Number);
  const sum = digits.reduce((total, digit, index) => total + digit * WEIGHTS[index], 0);
  return (10 - (sum % 10)) % 10;
};

const accounts = process.argv.slice(2);
if (accounts.length === 0 || accounts.some((a) => !/^\d{10}$/.test(a))) {
  process.stderr.write(
    "Pass one or more REAL 10-digit account numbers the Bank holds.\n" +
      "One usually narrows it to a handful; two or three settle it.\n\n" +
      "  node scripts/solve-nuban-bank-code.mjs 2024000153\n",
  );
  process.exit(2);
}

const candidates = [];
for (let code = 0; code < 1_000_000; code++) {
  const bankCode = String(code).padStart(6, "0");
  const fits = accounts.every(
    (account) => checkDigit(bankCode, account.slice(0, 9)) === Number(account[9]),
  );
  if (fits) candidates.push(bankCode);
}

const line = (text) => process.stdout.write(`${text}\n`);

line(`Checked ${accounts.length} account number(s): ${accounts.join(", ")}`);
line("");

if (candidates.length === 0) {
  line("No three-digit code fits all of them.");
  line("");
  line("That means one of three things, in the order worth checking:");
  line("  1. One of the numbers is mistyped.");
  line("  2. They are not all at the same bank.");
  line("  3. The weight vector is wrong for this institution — it is reproduced");
  line("     from the prototype rather than from the CBN circular, which the");
  line("     source comment in nuban.ts already flags as unconfirmed. If the");
  line("     numbers are definitely right, that is the thing to doubt.");
  process.exit(1);
}

line(`NUBAN_BANK_CODE=${candidates[0]}`);
line("");
line(`${candidates.length} codes fit, and they are equivalent: the bank code enters`);
line("the check digit only as a weighted sum mod 10, so all of these validate");
line("identically for every account number. More account numbers will not narrow");
line("this. Use the one above.");
line("");
line("If the Bank later states their real CBN code and it is not in this list,");
line("that is worth knowing — it would mean the weight vector is wrong, which");
line("nuban.ts already flags as reproduced from the prototype rather than from");
line("the CBN circular.");
line("");
line(`  a few more: ${candidates.slice(1, 8).join(", ")} …`);

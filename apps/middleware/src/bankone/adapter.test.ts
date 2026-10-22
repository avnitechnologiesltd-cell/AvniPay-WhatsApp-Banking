import { afterEach, describe, expect, it } from "vitest";

import type { BankOneConfig } from "@avni/config";
import {
  startFakeBankOne,
  type FakeBankOne,
  type FakeTransaction,
  type FakeTransactionDialect,
} from "@avni/fakes";

import { BankOneAdapter } from "./adapter";

/**
 * Driven against the fake BankOne over real HTTP rather than a mocked class,
 * because the code under test here is precisely the code that reads BankOne's
 * wire format — the commas, the two spellings, the 200-that-means-no.
 */

const AUTH_TOKEN = "test-auth-token";
const INSTITUTION_CODE = "test-institution";
const ACCOUNT = "0123456789";

let bankOne: FakeBankOne;

const adapterFor = (fake: FakeBankOne): BankOneAdapter => {
  const config: BankOneConfig = {
    webApiBaseUrl: fake.url,
    thirdPartyApiBaseUrl: fake.url,
    apiKey: AUTH_TOKEN,
    institutionCode: INSTITUTION_CODE,
    bankCode: "test-bank",
    productCode: "test-product",
    officerCode: "test-officer",
  };
  return new BankOneAdapter({ config });
};

const withBalance = async (naira: number): Promise<BankOneAdapter> => {
  bankOne = await startFakeBankOne({
    authToken: AUTH_TOKEN,
    institutionCode: INSTITUTION_CODE,
    accounts: [{ accountNumber: ACCOUNT, availableBalance: naira }],
  });
  return adapterFor(bankOne);
};

afterEach(async () => {
  await bankOne?.close();
});

describe("readBalance", () => {
  it("reports ₦1,000,000 as 1000000 and never as 1", async () => {
    // The whole reason this adapter exists. BankOne sends "1,000,000.00".
    const adapter = await withBalance(1_000_000);

    const result = await adapter.readBalance(ACCOUNT);

    expect(result).toEqual({
      outcome: "ok",
      value: {
        accountNumber: ACCOUNT,
        availableBalance: 1_000_000,
        ledgerBalance: 1_000_000,
        withdrawableBalance: 1_000_000,
        accountType: "Savings/Current Account",
      },
    });
  });

  it("treats the figure as naira and never divides by 100", async () => {
    const adapter = await withBalance(1500);

    const result = await adapter.readBalance(ACCOUNT);

    expect(result).toMatchObject({ outcome: "ok", value: { availableBalance: 1500 } });
  });

  it("passes no raw BankOne string upward", async () => {
    const adapter = await withBalance(1_000_000);

    const result = await adapter.readBalance(ACCOUNT);

    if (result.outcome !== "ok") expect.unreachable();
    for (const value of Object.values(result.value)) {
      expect(typeof value === "string" && /[\d],[\d]/.test(value)).toBe(false);
    }
    expect(typeof result.value.availableBalance).toBe("number");
  });

  it("reports a zero balance as zero rather than as a failure", async () => {
    const adapter = await withBalance(0);

    expect(await adapter.readBalance(ACCOUNT)).toMatchObject({
      outcome: "ok",
      value: { availableBalance: 0 },
    });
  });

  it("authenticates with the authtoken query parameter", async () => {
    const adapter = await withBalance(10);

    await adapter.readBalance(ACCOUNT);

    expect(bankOne.requests[0]?.query).toMatchObject({
      authtoken: AUTH_TOKEN,
      accountNumber: ACCOUNT,
      institutionCode: INSTITUTION_CODE,
    });
  });

  it("reads the success flag under either spelling", async () => {
    bankOne = await startFakeBankOne({
      authToken: AUTH_TOKEN,
      institutionCode: INSTITUTION_CODE,
      successFlagSpelling: "IsSuccessFul",
      accounts: [{ accountNumber: ACCOUNT, availableBalance: 250 }],
    });

    expect(await adapterFor(bankOne).readBalance(ACCOUNT)).toMatchObject({
      outcome: "ok",
      value: { availableBalance: 250 },
    });
  });

  it("answers not_found for an account BankOne does not hold", async () => {
    const adapter = await withBalance(10);

    expect(await adapter.readBalance("9999999999")).toEqual({ outcome: "not_found" });
  });

  it("answers unavailable — not failed — for an unentitled operation", async () => {
    // HTTP 200 carrying a message. Distinguishing this from a broken credential
    // is the difference between asking the Bank and fixing our own `.env`.
    bankOne = await startFakeBankOne({
      authToken: AUTH_TOKEN,
      institutionCode: INSTITUTION_CODE,
      unentitled: ["GetAccountByAccountNumber"],
    });

    const result = await adapterFor(bankOne).readBalance(ACCOUNT);

    expect(result.outcome).toBe("unavailable");
  });

  it("answers failed for a rejected token", async () => {
    bankOne = await startFakeBankOne({
      authToken: "a-different-token",
      institutionCode: INSTITUTION_CODE,
    });

    const result = await adapterFor(bankOne).readBalance(ACCOUNT);

    expect(result).toEqual({ outcome: "failed", reason: "Invalid Token" });
  });

  it("answers failed rather than ok when BankOne is unreachable", async () => {
    const adapter = await withBalance(10);
    await bankOne.close();

    const result = await adapter.readBalance(ACCOUNT);

    expect(result.outcome).toBe("failed");
  });

  it("refuses a balance it cannot read rather than reporting zero", async () => {
    // A parse failure must never become "you have ₦0".
    bankOne = await startFakeBankOne({
      authToken: AUTH_TOKEN,
      institutionCode: INSTITUTION_CODE,
    });
    bankOne.setAccount({ accountNumber: ACCOUNT, availableBalance: Number.NaN });

    const result = await adapterFor(bankOne).readBalance(ACCOUNT);

    expect(result.outcome).toBe("failed");
  });

  it("falls back to the available balance rather than zero for a missing figure", async () => {
    bankOne = await startFakeBankOne({ authToken: AUTH_TOKEN, institutionCode: INSTITUTION_CODE });
    const adapter = adapterFor(bankOne);
    bankOne.setAccount({ accountNumber: ACCOUNT, availableBalance: 4200 });

    const result = await adapter.readBalance(ACCOUNT);

    expect(result).toMatchObject({
      outcome: "ok",
      value: { availableBalance: 4200, ledgerBalance: 4200 },
    });
  });
});

/**
 * History, against a shape **nobody on this project has observed**. The fake
 * spells its rows three different ways because the specification's own field
 * table says *"e.g."*, and it ignores the date range in the query because the
 * parameter names for it are unconfirmed.
 */
describe("readTransactions", () => {
  const NOW = new Date("2026-08-20T09:15:00Z");
  const WINDOW = { from: new Date("2026-07-21T00:00:00Z"), to: NOW };

  const withHistory = async (
    transactions: readonly FakeTransaction[],
    dialect?: FakeTransactionDialect,
  ): Promise<BankOneAdapter> => {
    bankOne = await startFakeBankOne({
      authToken: AUTH_TOKEN,
      institutionCode: INSTITUTION_CODE,
      ...(dialect ? { transactionDialect: dialect } : {}),
      accounts: [{ accountNumber: ACCOUNT, availableBalance: 100_000, transactions }],
    });
    return adapterFor(bankOne);
  };

  const SALARY: FakeTransaction = {
    amount: 1_000_000,
    direction: "credit",
    occurredAt: new Date("2026-08-19T08:00:00Z"),
    narration: "Salary August",
    reference: "sal-1",
  };
  const AIRTIME: FakeTransaction = {
    amount: 5_000,
    direction: "debit",
    occurredAt: new Date("2026-08-20T07:30:00Z"),
    narration: "Airtime",
    reference: "air-1",
  };

  it.each(["documented", "alternate", "signed"] as const)(
    "reads the %s dialect to the same rows",
    async (dialect) => {
      // The point of the three dialects: whichever spelling the entitlement
      // turns out to answer in, what leaves the adapter is identical.
      const adapter = await withHistory([SALARY, AIRTIME], dialect);

      const result = await adapter.readTransactions(ACCOUNT, WINDOW);

      if (result.outcome !== "ok") expect.unreachable();
      // Compared unordered: the `signed` dialect's dates are unreadable, so
      // there is nothing to sort those rows by. Ordering has its own test.
      expect(result.value.map((row) => `${row.amount} ${row.direction}`).sort()).toEqual([
        "1000000 credit",
        "5000 debit",
      ]);
    },
  );

  it("reports ₦1,000,000 as 1000000 and never as 1", async () => {
    // The same rule as balances, in a list. It fails only above ₦1,000.
    const adapter = await withHistory([SALARY]);

    const result = await adapter.readTransactions(ACCOUNT, WINDOW);

    expect(result).toMatchObject({ outcome: "ok", value: [{ amount: 1_000_000 }] });
  });

  it("answers newest first", async () => {
    const adapter = await withHistory([SALARY, AIRTIME]);

    const result = await adapter.readTransactions(ACCOUNT, WINDOW);

    if (result.outcome !== "ok") expect.unreachable();
    expect(result.value.map((row) => row.narration)).toEqual(["Airtime", "Salary August"]);
  });

  it("keeps a row whose date it would not guess at", async () => {
    // The `signed` dialect dates rows `20/08/2026`, which is either the 20th of
    // August or the 8th of the 20th month. The date is dropped; the row is not,
    // because hiding money movement is worse than showing it undated.
    const adapter = await withHistory([SALARY], "signed");

    const result = await adapter.readTransactions(ACCOUNT, WINDOW);

    expect(result).toMatchObject({
      outcome: "ok",
      value: [{ amount: 1_000_000, occurredAt: undefined }],
    });
  });

  it("applies the window itself, because BankOne may ignore the one it was sent", async () => {
    // The fake ignores `fromDate` on purpose — the parameter names are
    // unverified, so a deployment that does not recognise them answers with
    // everything it has and looks like a success.
    const older = { ...SALARY, occurredAt: new Date("2026-01-05T08:00:00Z") };
    const adapter = await withHistory([older, AIRTIME]);

    const result = await adapter.readTransactions(ACCOUNT, WINDOW);

    if (result.outcome !== "ok") expect.unreachable();
    expect(result.value.map((row) => row.narration)).toEqual(["Airtime"]);
  });

  it("asks for the window anyway, under the names the guide leads with", async () => {
    const adapter = await withHistory([]);

    await adapter.readTransactions(ACCOUNT, WINDOW);

    expect(bankOne.requests[0]?.query).toMatchObject({
      authtoken: AUTH_TOKEN,
      accountNumber: ACCOUNT,
      institutionCode: INSTITUTION_CODE,
      fromDate: "2026-07-21",
      toDate: "2026-08-20",
    });
  });

  it("answers an empty list for a quiet month rather than a failure", async () => {
    const adapter = await withHistory([]);

    expect(await adapter.readTransactions(ACCOUNT, WINDOW)).toEqual({ outcome: "ok", value: [] });
  });

  it("answers unavailable — not failed — on an unentitled token", async () => {
    // The first deployment, today. HTTP 200 carrying a message, which is an entitlement
    // to request rather than an error to retry.
    bankOne = await startFakeBankOne({
      authToken: AUTH_TOKEN,
      institutionCode: INSTITUTION_CODE,
      unentitled: ["GetTransactions"],
      accounts: [{ accountNumber: ACCOUNT, availableBalance: 100_000 }],
    });

    const result = await adapterFor(bankOne).readTransactions(ACCOUNT, WINDOW);

    expect(result.outcome).toBe("unavailable");
  });

  it("answers unavailable before the entitlement and ok after it", async () => {
    bankOne = await startFakeBankOne({
      authToken: AUTH_TOKEN,
      institutionCode: INSTITUTION_CODE,
      unentitled: ["GetTransactions"],
      accounts: [{ accountNumber: ACCOUNT, availableBalance: 100_000, transactions: [AIRTIME] }],
    });
    const adapter = adapterFor(bankOne);

    const before = await adapter.readTransactions(ACCOUNT, WINDOW);
    bankOne.setEntitled("GetTransactions", true);
    const after = await adapter.readTransactions(ACCOUNT, WINDOW);

    expect(before.outcome).toBe("unavailable");
    expect(after).toMatchObject({ outcome: "ok", value: [{ amount: 5_000, direction: "debit" }] });
  });

  it("fails the whole read rather than quietly dropping a row it cannot read", async () => {
    // A list with a transaction missing from it is the same class of error as
    // reporting ₦1,000,000 as ₦1, and considerably harder to notice.
    const adapter = await withHistory([{ ...AIRTIME, amount: Number.NaN }]);

    const result = await adapter.readTransactions(ACCOUNT, WINDOW);

    expect(result.outcome).toBe("failed");
  });

  it("refuses a declared failure even when an empty list comes with it", async () => {
    // The nastiest shape on this path: `{"IsSuccessful": false, "Transactions": []}`
    // is a refusal, and taking the list beside it as an answer would tell a
    // Customer nothing happened on their account. A bare array, which has
    // nowhere to put a flag, must still succeed — so the check is conditional
    // on a flag being present rather than on it being true.
    const adapter = await withHistory([AIRTIME]);
    bankOne.setDeclaredFailure("GetTransactions", "Unable to retrieve transactions");

    const result = await adapter.readTransactions(ACCOUNT, WINDOW);

    expect(result).toEqual({ outcome: "failed", reason: "Unable to retrieve transactions" });
  });

  it("still succeeds on a bare array, which carries no success flag at all", async () => {
    const adapter = await withHistory([AIRTIME], "alternate");

    const result = await adapter.readTransactions(ACCOUNT, WINDOW);

    expect(result).toMatchObject({ outcome: "ok", value: [{ amount: 5_000 }] });
  });

  it("fails on a body carrying no list at all", async () => {
    // A shape we have never seen must not read as an account with nothing on it.
    bankOne = await startFakeBankOne({
      authToken: "a-different-token",
      institutionCode: INSTITUTION_CODE,
    });

    const result = await adapterFor(bankOne).readTransactions(ACCOUNT, WINDOW);

    expect(result.outcome).toBe("failed");
  });

  it("takes no Transaction PIN and builds no Mandate", async () => {
    // A read is silent. Nothing but a GET with the token in the query.
    const adapter = await withHistory([AIRTIME]);

    await adapter.readTransactions(ACCOUNT, WINDOW);

    expect(bankOne.requests).toHaveLength(1);
    expect(bankOne.requests[0]?.method).toBe("GET");
    expect(bankOne.requests[0]?.body).toBeUndefined();
  });
});

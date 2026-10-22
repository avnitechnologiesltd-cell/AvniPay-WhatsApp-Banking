import { afterEach, describe, expect, it } from "vitest";

import { formatBankOneAmount, startFakeBankOne, type FakeBankOne } from "./bankone";

/**
 * A fake that lies about the wire format is worse than no fake, because every
 * test above it then passes against a BankOne that does not exist. These check
 * the fake against Appendix A rather than against the guide.
 */

const AUTH_TOKEN = "test-auth-token";
const INSTITUTION_CODE = "test-institution";

let bankOne: FakeBankOne;

afterEach(async () => {
  await bankOne?.close();
});

const balanceUrl = (
  base: string,
  params: Record<string, string> = {},
): string => {
  const url = new URL(`${base}/api/Account/GetAccountByAccountNumber/2`);
  for (const [key, value] of Object.entries({
    authtoken: AUTH_TOKEN,
    accountNumber: "0123456789",
    institutionCode: INSTITUTION_CODE,
    ...params,
  })) {
    url.searchParams.set(key, value);
  }
  return url.toString();
};

describe("formatBankOneAmount", () => {
  it("groups thousands with a comma, which is the whole reason this fake exists", () => {
    expect(formatBankOneAmount(1_000_000)).toBe("1,000,000.00");
    expect(formatBankOneAmount(1000)).toBe("1,000.00");
  });

  it("leaves smaller amounts ungrouped, which is why small-value testing misses it", () => {
    expect(formatBankOneAmount(999.5)).toBe("999.50");
    expect(formatBankOneAmount(0)).toBe("0.00");
  });

  it("always carries two decimal places", () => {
    expect(formatBankOneAmount(1500)).toBe("1,500.00");
    expect(formatBankOneAmount(12.3)).toBe("12.30");
  });
});

describe("the BankOne fake", () => {
  it("returns a balance as a naira decimal string with separators", async () => {
    bankOne = await startFakeBankOne({
      authToken: AUTH_TOKEN,
      institutionCode: INSTITUTION_CODE,
      accounts: [{ accountNumber: "0123456789", availableBalance: 1_000_000 }],
    });

    const body = (await (await fetch(balanceUrl(bankOne.url))).json()) as Record<string, unknown>;

    expect(body["AvailableBalance"]).toBe("1,000,000.00");
    expect(body["IsSuccessful"]).toBe(true);
  });

  it("spells the success flag the other documented way when asked", async () => {
    bankOne = await startFakeBankOne({
      authToken: AUTH_TOKEN,
      institutionCode: INSTITUTION_CODE,
      successFlagSpelling: "IsSuccessFul",
      accounts: [{ accountNumber: "0123456789", availableBalance: 10 }],
    });

    const body = (await (await fetch(balanceUrl(bankOne.url))).json()) as Record<string, unknown>;

    expect(body["IsSuccessFul"]).toBe(true);
    expect(body["IsSuccessful"]).toBeUndefined();
  });

  it("authenticates by the authtoken query parameter, as the WebAPI does", async () => {
    bankOne = await startFakeBankOne({ authToken: AUTH_TOKEN, institutionCode: INSTITUTION_CODE });

    const response = await fetch(balanceUrl(bankOne.url, { authtoken: "wrong" }));

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Invalid Token");
  });

  it("answers an unentitled operation with HTTP 200 and a message", async () => {
    // The distinction Appendix A.1 draws: a bad token is a 400, an unentitled
    // operation is a 200. One is our problem, the other is the Bank's.
    bankOne = await startFakeBankOne({
      authToken: AUTH_TOKEN,
      institutionCode: INSTITUTION_CODE,
      unentitled: ["GetAccountByAccountNumber"],
    });

    const response = await fetch(balanceUrl(bankOne.url));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("AuthToken Not Configured for this institution");
  });

  it("answers an unknown account with a plain-text 404", async () => {
    bankOne = await startFakeBankOne({ authToken: AUTH_TOKEN, institutionCode: INSTITUTION_CODE });

    const response = await fetch(balanceUrl(bankOne.url, { accountNumber: "9999999999" }));

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("text/plain");
  });

  it("records what it was asked, so a caller's auth can be asserted", async () => {
    bankOne = await startFakeBankOne({
      authToken: AUTH_TOKEN,
      institutionCode: INSTITUTION_CODE,
      accounts: [{ accountNumber: "0123456789", availableBalance: 5 }],
    });

    await fetch(balanceUrl(bankOne.url));

    expect(bankOne.requests).toHaveLength(1);
    expect(bankOne.requests[0]?.query).toMatchObject({
      authtoken: AUTH_TOKEN,
      accountNumber: "0123456789",
      institutionCode: INSTITUTION_CODE,
    });
  });
});

/**
 * `GetTransactions` is the one endpoint here whose real shape **nobody on this
 * project has seen** — the first deployment's token is not entitled to it and
 * `GetDailyAccountStatement` 404s on their deployment (Appendix A.1). So these
 * check that the fake keeps lying in all three of the ways the guide's *"e.g."*
 * column allows, rather than settling into one an adapter could bet on.
 */
describe("GetTransactions", () => {
  const ACCOUNT = "0123456789";
  const SALARY = {
    amount: 1_000_000,
    direction: "credit",
    occurredAt: new Date("2026-08-19T08:00:00Z"),
    narration: "Salary August",
    reference: "sal-1",
  } as const;

  const transactionsUrl = (base: string): string => {
    const url = new URL(`${base}/api/Account/GetTransactions/2`);
    url.searchParams.set("authtoken", AUTH_TOKEN);
    url.searchParams.set("accountNumber", ACCOUNT);
    url.searchParams.set("institutionCode", INSTITUTION_CODE);
    url.searchParams.set("fromDate", "2026-07-21");
    url.searchParams.set("toDate", "2026-08-21");
    return url.toString();
  };

  const answerFor = async (dialect?: "documented" | "alternate" | "signed"): Promise<unknown> => {
    bankOne = await startFakeBankOne({
      authToken: AUTH_TOKEN,
      institutionCode: INSTITUTION_CODE,
      ...(dialect ? { transactionDialect: dialect } : {}),
      accounts: [{ accountNumber: ACCOUNT, availableBalance: 1_000_000, transactions: [SALARY] }],
    });
    const response = await fetch(transactionsUrl(bankOne.url));
    return response.json();
  };

  it("puts thousands separators in a row amount, exactly as it does in a balance", async () => {
    // The failure Appendix A.2 is about does not stop at balances.
    const body = (await answerFor()) as { Transactions: { Amount: string }[] };

    expect(body.Transactions[0]?.Amount).toBe("1,000,000.00");
  });

  it("spells the same row three genuinely different ways", async () => {
    const documented = (await answerFor("documented")) as { Transactions: unknown[] };
    expect(Object.keys(documented.Transactions[0] as object)).toEqual([
      "Amount",
      "RecordType",
      "TransactionDate",
      "Narration",
      "ReferenceID",
    ]);
    await bankOne.close();

    // A bare array, with no success flag anywhere in it to read.
    const alternate = (await answerFor("alternate")) as unknown[];
    expect(Array.isArray(alternate)).toBe(true);
    expect(Object.keys(alternate[0] as object)).toEqual([
      "TransactionAmount",
      "DrCr",
      "PostingDate",
      "Description",
      "TransactionReference",
    ]);
    await bankOne.close();

    // No credit/debit marker at all: the sign is the only signal.
    const signed = (await answerFor("signed")) as { Data: { Amount: string }[] };
    expect(Object.keys(signed.Data[0] as object)).toEqual([
      "Amount",
      "ValueDate",
      "TransactionDetails",
      "Reference",
    ]);
  });

  it("ignores the date range it was sent, because those parameter names are a guess", async () => {
    // Section 11 says to confirm them against a bank that has history enabled.
    // Until somebody has, an adapter that trusts the server to filter is
    // trusting a guess — so the fake makes that guess fail out loud.
    bankOne = await startFakeBankOne({
      authToken: AUTH_TOKEN,
      institutionCode: INSTITUTION_CODE,
      accounts: [
        {
          accountNumber: ACCOUNT,
          availableBalance: 10,
          transactions: [{ ...SALARY, occurredAt: new Date("2019-01-01T00:00:00Z") }],
        },
      ],
    });

    const body = (await (await fetch(transactionsUrl(bankOne.url))).json()) as {
      Transactions: unknown[];
    };

    expect(body.Transactions).toHaveLength(1);
  });

  it("answers HTTP 200 and a message when the operation is not entitled", async () => {
    // The first deployment today. Never an error status — that is a broken credential.
    bankOne = await startFakeBankOne({
      authToken: AUTH_TOKEN,
      institutionCode: INSTITUTION_CODE,
      unentitled: ["GetTransactions"],
      accounts: [{ accountNumber: ACCOUNT, availableBalance: 10 }],
    });

    const response = await fetch(transactionsUrl(bankOne.url));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("AuthToken Not Configured for this institution");
  });

  it("can be granted the entitlement without restarting", async () => {
    bankOne = await startFakeBankOne({
      authToken: AUTH_TOKEN,
      institutionCode: INSTITUTION_CODE,
      unentitled: ["GetTransactions"],
      accounts: [{ accountNumber: ACCOUNT, availableBalance: 10, transactions: [SALARY] }],
    });

    bankOne.setEntitled("GetTransactions", true);
    const body = (await (await fetch(transactionsUrl(bankOne.url))).json()) as {
      Transactions: unknown[];
    };

    expect(body.Transactions).toHaveLength(1);
  });
});

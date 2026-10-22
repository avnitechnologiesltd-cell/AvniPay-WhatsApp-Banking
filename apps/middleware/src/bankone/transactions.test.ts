import { describe, expect, it } from "vitest";

import {
  UnreadableTransactionError,
  readTransaction,
  readTransactionDate,
  transactionRowsIn,
} from "./transactions";

/**
 * The shape under test has **never been observed**. The first deployment's token is not
 * entitled to `GetTransactions` and `GetDailyAccountStatement` 404s on their
 * deployment (Appendix A.1), so the specification lists field names with
 * *"e.g."* beside them and this module reads all of them.
 *
 * These tests are therefore written the other way round from most: they assert
 * that several different shapes all read the same, and that the shapes which
 * cannot be read honestly are **refused** rather than approximated.
 */

describe("transactionRowsIn", () => {
  it("finds the rows whether BankOne wrapped them or not", () => {
    const rows = [{ Amount: "1.00" }];

    expect(transactionRowsIn(rows)).toEqual(rows);
    expect(transactionRowsIn({ Transactions: rows })).toEqual(rows);
    expect(transactionRowsIn({ Data: rows })).toEqual(rows);
    expect(transactionRowsIn({ Items: rows })).toEqual(rows);
  });

  it("tells a body it does not understand apart from a quiet month", () => {
    // `undefined` and `[]` mean different things, and the caller has to act on
    // the difference: one is a failure, the other is an answer.
    expect(transactionRowsIn({ IsSuccessful: false, Message: "no" })).toBeUndefined();
    expect(transactionRowsIn("AuthToken Not Configured for this institution")).toBeUndefined();
    expect(transactionRowsIn({ Transactions: [] })).toEqual([]);
  });
});

describe("readTransaction", () => {
  it("reads the documented spelling", () => {
    expect(
      readTransaction({
        Amount: "5,000.00",
        RecordType: "D",
        TransactionDate: "2026-08-20T14:03:11",
        Narration: "Transfer to MUSA",
        ReferenceID: "ref-1",
      }),
    ).toEqual({
      amount: 5000,
      direction: "debit",
      occurredAt: new Date("2026-08-20T14:03:11Z"),
      narration: "Transfer to MUSA",
      reference: "ref-1",
    });
  });

  it("reads the alternate spelling to exactly the same row", () => {
    expect(
      readTransaction({
        TransactionAmount: "5,000.00",
        DrCr: "DR",
        PostingDate: `/Date(${Date.UTC(2026, 7, 20, 14, 3, 11)})/`,
        Description: "Transfer to MUSA",
        TransactionReference: "ref-1",
      }),
    ).toEqual({
      amount: 5000,
      direction: "debit",
      occurredAt: new Date("2026-08-20T14:03:11Z"),
      narration: "Transfer to MUSA",
      reference: "ref-1",
    });
  });

  it("reads ₦1,000,000 as 1000000 and never as 1", () => {
    // The same rule as balances, and the same reason: `parseFloat` on
    // "1,000,000.00" is 1, and it only ever fails above ₦1,000.
    expect(readTransaction({ Amount: "1,000,000.00", RecordType: "C" })).toMatchObject({
      amount: 1_000_000,
      direction: "credit",
    });
  });

  it("takes the sign as the direction where BankOne sent no marker", () => {
    expect(readTransaction({ Amount: "-5,000.00", ValueDate: "" })).toMatchObject({
      amount: 5000,
      direction: "debit",
    });
    expect(readTransaction({ Amount: "5,000.00" })).toMatchObject({
      amount: 5000,
      direction: "credit",
    });
  });

  it("prefers the marker over the sign", () => {
    expect(readTransaction({ Amount: "-5,000.00", RecordType: "C" })).toMatchObject({
      amount: 5000,
      direction: "credit",
    });
  });

  it.each(["C", "cr", "Credit", "  CR  "])("reads %s as money in", (marker) => {
    expect(readTransaction({ Amount: "10.00", DrCr: marker }).direction).toBe("credit");
  });

  it.each(["D", "dr", "Debit", "withdrawal"])("reads %s as money out", (marker) => {
    expect(readTransaction({ Amount: "10.00", DrCr: marker }).direction).toBe("debit");
  });

  it("refuses a dedicated marker it does not recognise rather than picking one", () => {
    // Reading a debit as a credit is the single worst thing this module could
    // do, so an unknown vocabulary in a field whose only job is to say Dr or Cr
    // fails loudly.
    expect(() => readTransaction({ Amount: "10.00", RecordType: "X" })).toThrow(
      UnreadableTransactionError,
    );
    expect(() => readTransaction({ Amount: "10.00", DrCr: "maybe" })).toThrow(
      UnreadableTransactionError,
    );
  });

  it("ignores a Type naming a category, rather than dying on it", () => {
    // The guide lists `Type` beside `RecordType`, but in most banking APIs it
    // names a category — POS, NIP, TRANSFER — not a direction. Killing a whole
    // history read over one would be defending against the wrong thing.
    expect(readTransaction({ Amount: "-10.00", Type: "POS" })).toMatchObject({
      amount: 10,
      direction: "debit",
    });
    expect(readTransaction({ Amount: "10.00", TransactionType: "NIP" }).direction).toBe("credit");
  });

  it("still reads a Type that does say a direction", () => {
    expect(readTransaction({ Amount: "10.00", Type: "Debit" }).direction).toBe("debit");
  });

  it("refuses a row whose amount cannot be read", () => {
    expect(() => readTransaction({ Amount: "N/A", RecordType: "C" })).toThrow(
      UnreadableTransactionError,
    );
    expect(() => readTransaction({ RecordType: "C" })).toThrow(UnreadableTransactionError);
  });

  it("leaves an empty narration and reference absent rather than blank", () => {
    expect(readTransaction({ Amount: "10.00", Narration: "   ", ReferenceID: "" })).toMatchObject({
      narration: undefined,
      reference: undefined,
    });
  });
});

describe("readTransactionDate", () => {
  it("reads ISO with and without a timezone, treating a missing one as UTC", () => {
    expect(readTransactionDate("2026-08-20T14:03:11")).toEqual(new Date("2026-08-20T14:03:11Z"));
    expect(readTransactionDate("2026-08-20T14:03:11Z")).toEqual(new Date("2026-08-20T14:03:11Z"));
    expect(readTransactionDate("2026-08-20T15:03:11+01:00")).toEqual(
      new Date("2026-08-20T14:03:11Z"),
    );
    expect(readTransactionDate("2026-08-20")).toEqual(new Date("2026-08-20T00:00:00Z"));
  });

  it("reads ASP.NET's JSON date, offset or not", () => {
    expect(readTransactionDate("/Date(1755700000000)/")).toEqual(new Date(1_755_700_000_000));
    expect(readTransactionDate("/Date(1755700000000+0100)/")).toEqual(new Date(1_755_700_000_000));
  });

  it("will not guess at dd/MM versus MM/dd", () => {
    // The same nine characters mean two different days. A date the platform
    // invented is worse than a row shown without one.
    expect(readTransactionDate("20/08/2026")).toBeUndefined();
    expect(readTransactionDate("08/20/2026")).toBeUndefined();
  });

  it("answers undefined for anything else rather than the epoch", () => {
    expect(readTransactionDate(undefined)).toBeUndefined();
    expect(readTransactionDate("")).toBeUndefined();
    expect(readTransactionDate("not a date")).toBeUndefined();
    expect(readTransactionDate({})).toBeUndefined();
  });
});

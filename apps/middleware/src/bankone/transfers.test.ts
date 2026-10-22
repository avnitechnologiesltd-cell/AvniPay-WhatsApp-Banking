import { describe, expect, it } from "vitest";

import { isValidationFailure, readStatusResponse, readTransferResponse } from "./transfers";

/**
 * The two readings of "did the money move", against the shapes BankOne actually
 * sends.
 *
 * These are unit tests rather than journeys on purpose: the difference between
 * them is one field, the consequence of getting it wrong is telling a Customer a
 * failed transfer succeeded, and a journey that happened to use the right shape
 * would prove nothing about the one it did not.
 */

describe("reading a transfer response", () => {
  it("takes response code 00 as success", () => {
    expect(
      readTransferResponse({
        IsSuccessful: true,
        ResponseMessage: "Approved by Financial Institution",
        ResponseCode: "00",
        Reference: "A2009110171",
      }),
    ).toMatchObject({ outcome: "succeeded" });
  });

  it("takes the documented pending codes as pending rather than as failure", () => {
    for (const code of ["01", "09", "25", "91"]) {
      expect(readTransferResponse({ ResponseCode: code })).toMatchObject({ outcome: "pending" });
    }
  });

  it("takes a business failure as a failure, and keeps BankOne's words", () => {
    const result = readTransferResponse({
      IsSuccessFul: false,
      ResponseCode: "96",
      ResponseMessage: "Sender account name is not valid",
    });

    expect(result.outcome).toBe("failed");
    expect(result.reason).toContain("Sender account name is not valid");
    // The code goes with it: "96" and "12" are a business rule and a malformed
    // request, and an operator reading the audit row needs to know which.
    expect(result.reason).toContain("96");
  });

  it("takes a code nobody documented as a failure rather than falling through", () => {
    // `06` was observed in the wild and is in no table. Every reader here fails
    // closed: an unrecognised code is never read as money having arrived.
    expect(readTransferResponse({ ResponseCode: "06" })).toMatchObject({ outcome: "failed" });
    expect(readTransferResponse({ ResponseCode: "ZZ" })).toMatchObject({ outcome: "failed" });
  });

  it("reads either spelling of the success flag where there is no code", () => {
    expect(readTransferResponse({ IsSuccessful: true })).toMatchObject({ outcome: "succeeded" });
    expect(readTransferResponse({ IsSuccessFul: true })).toMatchObject({ outcome: "succeeded" });
    expect(readTransferResponse({ IsSuccessFul: false })).toMatchObject({ outcome: "failed" });
  });

  it("reads the inter-bank endpoint's own spelling of the flag", () => {
    // `bankone-api.md` §8, verbatim, and the guide flags the casing itself:
    // this endpoint spells it `IsSuccessFul`. A reader fixed on the other
    // spelling would find no flag on the endpoint that moves money to another
    // bank.
    expect(
      readTransferResponse({
        Status: "Failed",
        IsSuccessFul: false,
        ResponseCode: "96",
        ResponseMessage: "Sender account name is not valid",
        Reference: "txn123456789",
      }),
    ).toMatchObject({ outcome: "failed", code: "96" });
  });

  it("tells a malformed request apart from a business decline", () => {
    // Both mean the money stayed, and the Customer is told the same true thing
    // either way. The Bank is not: a `96` is somebody declining a transfer, a
    // `12` is the Middleware having sent something BankOne would not accept,
    // and only one of those is a defect to go and fix.
    const declined = readTransferResponse({ ResponseCode: "96", ResponseMessage: "Insufficient funds" });
    const malformed = readTransferResponse({
      Status: 12,
      IsSuccessFul: false,
      ResponseCode: "12",
      ResponseMessage: "Receiverbankcode not sent",
    });

    expect(declined.outcome).toBe("failed");
    expect(malformed.outcome).toBe("failed");
    expect(isValidationFailure(declined)).toBe(false);
    expect(isValidationFailure(malformed)).toBe(true);
  });

  it("answers 'unknown' to a body with nothing in it to read", () => {
    // Not a failure. A response that says nothing about the money is not
    // evidence the money stayed — it is a question for the status query, and
    // reading it as failure is how a Customer is told a transfer failed while
    // their balance says otherwise.
    expect(readTransferResponse({})).toMatchObject({ outcome: "unknown" });
    expect(readTransferResponse("<html>502 Bad Gateway</html>")).toMatchObject({
      outcome: "unknown",
    });
  });
});

describe("reading a status query", () => {
  it("reads a failure through a truthy IsSuccessful", () => {
    // Appendix A.3, verbatim. `IsSuccessful: true` means the *query* ran. The
    // general rule — treat a truthy flag as success — is wrong for the one
    // endpoint whose whole job is establishing whether money moved.
    expect(
      readStatusResponse({
        IsSuccessful: true,
        ResponseMessage: "Failed",
        ResponseCode: "06",
        Status: "Failed",
      }),
    ).toMatchObject({ outcome: "failed" });
  });

  it("does not read a truthy flag as success where there is no code or status", () => {
    expect(readStatusResponse({ IsSuccessful: true })).toMatchObject({ outcome: "unknown" });
  });

  it("reads the status word where BankOne sends no code", () => {
    expect(readStatusResponse({ Status: "Successful" })).toMatchObject({ outcome: "succeeded" });
    expect(readStatusResponse({ Status: "Pending" })).toMatchObject({ outcome: "pending" });
    expect(readStatusResponse({ Status: "Failed" })).toMatchObject({ outcome: "failed" });
    // A word nobody documented is a failure, for the same reason a code is.
    expect(readStatusResponse({ Status: "Whatever" })).toMatchObject({ outcome: "failed" });
  });

  it("reads a settled success as success", () => {
    expect(readStatusResponse({ ResponseCode: "00", Status: "Successful" })).toMatchObject({
      outcome: "succeeded",
    });
  });
});

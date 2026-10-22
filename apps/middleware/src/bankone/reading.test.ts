import { describe, expect, it } from "vitest";

import { failureMessage, field, isSuccessfulCall, stringField } from "./reading";

describe("field", () => {
  it("matches a name case-insensitively", () => {
    expect(field({ AvailableBalance: "10.00" }, "availablebalance")).toBe("10.00");
    expect(field({ availablebalance: "10.00" }, "AvailableBalance")).toBe("10.00");
  });

  it("takes the first spelling that is present", () => {
    expect(field({ IsSuccessFul: true }, "IsSuccessful", "IsSuccessFul")).toBe(true);
  });

  it("skips a null as though it were absent", () => {
    expect(field({ Message: null, ResponseMessage: "Failed" }, "Message", "ResponseMessage")).toBe(
      "Failed",
    );
  });

  it("answers undefined for a body that is not an object", () => {
    for (const body of [null, undefined, "Invalid Token", 42]) {
      expect(field(body, "anything")).toBeUndefined();
    }
  });
});

describe("stringField", () => {
  it("reads a code BankOne sent unquoted", () => {
    expect(stringField({ ResponseCode: 0 }, "ResponseCode")).toBe("0");
  });

  it("declines a value that is neither string nor number", () => {
    expect(stringField({ ResponseCode: { nested: true } }, "ResponseCode")).toBeUndefined();
  });
});

describe("isSuccessfulCall", () => {
  it("accepts response code 00", () => {
    expect(isSuccessfulCall({ ResponseCode: "00" })).toBe(true);
  });

  it("accepts either spelling of the success flag", () => {
    expect(isSuccessfulCall({ IsSuccessful: true })).toBe(true);
    expect(isSuccessfulCall({ IsSuccessFul: true })).toBe(true);
  });

  it("refuses an unrecognised response code rather than falling through", () => {
    // `06` was observed and is in no documented table (Appendix A.3). Treating
    // an unknown code as success is how a failed transfer gets reported as done.
    expect(isSuccessfulCall({ ResponseCode: "06" })).toBe(false);
    expect(isSuccessfulCall({ ResponseCode: "51" })).toBe(false);
  });

  it("refuses a body with neither a code nor a flag", () => {
    expect(isSuccessfulCall({})).toBe(false);
    expect(isSuccessfulCall("AuthToken Not Configured for this institution")).toBe(false);
  });
});

describe("failureMessage", () => {
  it("finds the message under any of its spellings", () => {
    expect(failureMessage({ ResponseMessage: "Failed" })).toBe("Failed");
    expect(failureMessage({ Message: "Invalid Token" })).toBe("Invalid Token");
  });

  it("answers undefined when BankOne said nothing", () => {
    expect(failureMessage({})).toBeUndefined();
  });
});

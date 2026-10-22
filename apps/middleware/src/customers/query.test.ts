import { describe, expect, it } from "vitest";

import { readCustomerQuery } from "./query";

/**
 * What an Officer typed, and the reason this never chooses between the two
 * readings when both are possible.
 */
describe("what a Support Officer typed", () => {
  it("reads ten digits as an account number", () => {
    expect(readCustomerQuery("0123456789")).toEqual({ accountNumber: "0123456789" });
  });

  it("reads ten digits as a mobile number missing its trunk zero, as well", () => {
    // `8012345678` is a well-formed NUBAN shape *and* a Nigerian subscriber
    // number, and nothing in the digits tells them apart. Both lookups run,
    // because guessing would mean an Officer typing a real query and being told
    // there is no such Customer.
    expect(readCustomerQuery("8012345678")).toEqual({
      accountNumber: "8012345678",
      channelIdentity: "2348012345678",
    });
  });

  it("reads a local mobile number as the WhatsApp identity it becomes", () => {
    expect(readCustomerQuery("08012345678")).toEqual({ channelIdentity: "2348012345678" });
  });

  it("reads the number the way WhatsApp itself reports it", () => {
    expect(readCustomerQuery("2348012345678")).toEqual({ channelIdentity: "2348012345678" });
  });

  it("reads a dialling code that kept its trunk zero", () => {
    // `+234 0801 …` is what somebody typing carefully and wrongly produces, and
    // it is the commonest malformed Nigerian number there is.
    expect(readCustomerQuery("+23408012345678")).toEqual({ channelIdentity: "2348012345678" });
  });

  it("ignores spaces, dashes, brackets and a leading plus", () => {
    expect(readCustomerQuery(" +234 (801) 234-5678 ")).toEqual({
      channelIdentity: "2348012345678",
    });
  });

  it("does not invent a mobile number out of digits no operator issues", () => {
    // Nigerian subscriber numbers begin 7, 8 or 9. An account number beginning
    // 0 is not also somebody's handset, and searching for it as one would put a
    // meaningless lookup in front of an audited surface.
    expect(readCustomerQuery("0123456789").channelIdentity).toBeUndefined();
  });

  it("finds nothing to look up in something that is neither", () => {
    for (const typed of ["", "   ", "12345", "01234567890123456789"]) {
      expect(readCustomerQuery(typed)).toEqual({});
    }
  });

  it("finds nothing to look up in a name, however much it looks like one", () => {
    // **There is no name search.** BankOne resolves an account number to a name
    // and never the other way, and the Bank's identity API is forbidden from
    // answering with a name at all — so a name is honestly unanswerable here
    // rather than quietly empty.
    expect(readCustomerQuery("MUSA OKONKWO")).toEqual({});
  });
});

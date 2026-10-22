import { describe, expect, it } from "vitest";

import { maskChannelIdentity } from "./masking";

describe("a Customer's number on a Support Officer's screen", () => {
  it("shows the last four digits and no more", () => {
    expect(maskChannelIdentity("2348012345678")).toBe("••• ••• 5678");
  });

  it("never carries the rest of the number in the string it returns", () => {
    // The whole point. A masked value that still holds the digits is a mask on
    // the screen and a leak in the payload.
    expect(maskChannelIdentity("2348012345678")).not.toContain("801");
    expect(maskChannelIdentity("2348012345678")).not.toContain("234");
  });

  it("says nothing rather than almost nothing when there is no tail", () => {
    expect(maskChannelIdentity("12")).toBe("••• •••");
  });
});

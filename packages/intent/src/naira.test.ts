import { describe, expect, it } from "vitest";

import { formatNaira } from "./naira";

describe("formatNaira", () => {
  it("shows a million as a million", () => {
    expect(formatNaira(1_000_000)).toBe("₦1,000,000");
  });

  it("groups thousands so a large figure is readable", () => {
    expect(formatNaira(1000)).toBe("₦1,000");
    expect(formatNaira(250_000)).toBe("₦250,000");
  });

  it("keeps kobo when there is any, and drops it when there is none", () => {
    expect(formatNaira(1234.5)).toBe("₦1,234.50");
    expect(formatNaira(1234)).toBe("₦1,234");
  });

  it("shows an empty account as zero rather than as nothing", () => {
    expect(formatNaira(0)).toBe("₦0");
  });
});

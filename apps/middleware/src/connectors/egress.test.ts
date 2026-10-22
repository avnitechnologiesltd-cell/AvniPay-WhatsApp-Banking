import { describe, expect, it } from "vitest";

import { addressProblem, endpointProblem, kindOfAddress } from "./egress";

describe("what a resolved address is", () => {
  it.each([
    ["8.8.8.8", "public"],
    ["203.0.113.7", "public"],
    ["2606:4700:4700::1111", "public"],
  ])("calls %s %s", (address, kind) => {
    expect(kindOfAddress(address)).toBe(kind);
  });

  it.each([
    ["127.0.0.1", "loopback"],
    ["127.19.0.3", "loopback"],
    ["::1", "loopback"],
    ["10.0.0.5", "private"],
    ["172.16.4.1", "private"],
    ["172.31.255.254", "private"],
    ["192.168.1.1", "private"],
    ["100.64.0.1", "private"],
    ["fd00::1", "private"],
    ["169.254.169.254", "link_local"],
    ["fe80::1", "link_local"],
    ["0.0.0.0", "unspecified"],
    ["::", "unspecified"],
    ["224.0.0.1", "multicast"],
    ["255.255.255.255", "reserved"],
  ])("refuses %s as %s", (address, kind) => {
    expect(kindOfAddress(address)).toBe(kind);
    expect(addressProblem(address)).toBeDefined();
  });

  /** `172.32.x` is outside the private block, and off-by-one here is a hole. */
  it("does not mistake a neighbour of a private block for one", () => {
    expect(kindOfAddress("172.32.0.1")).toBe("public");
    expect(kindOfAddress("172.15.255.255")).toBe("public");
    expect(kindOfAddress("11.0.0.1")).toBe("public");
    expect(kindOfAddress("100.128.0.1")).toBe("public");
  });

  /**
   * **The bypass that looks like a different address family.** `::ffff:127.0.0.1`
   * is loopback wearing an IPv6 hat, and a check that read it as v6 and stopped
   * would let it straight through.
   */
  it.each(["::ffff:127.0.0.1", "::ffff:169.254.169.254", "::ffff:10.0.0.1"])(
    "unwraps %s and judges the address inside it",
    (address) => {
      expect(addressProblem(address)).toBeDefined();
    },
  );

  it("refuses anything it cannot read as an address at all", () => {
    for (const value of ["", "not-an-address", "999.1.1.1", "10.0.0", "::gg"]) {
      expect(addressProblem(value)).toBeDefined();
    }
  });
});

describe("what an Administrator may register", () => {
  it("accepts an ordinary HTTPS endpoint", () => {
    expect(endpointProblem("https://cards.bank.example/v1/block")).toBeUndefined();
    expect(endpointProblem("https://cards.bank.example:8443/v1/block")).toBeUndefined();
  });

  /**
   * HTTPS with certificate verification, or nothing. The credential the Bank
   * pasted into the form travels on this request.
   */
  it("refuses plain HTTP", () => {
    expect(endpointProblem("http://cards.bank.example/v1/block")).toMatch(/https/i);
  });

  it("refuses a scheme that is not the web", () => {
    expect(endpointProblem("file:///etc/passwd")).toBeDefined();
    expect(endpointProblem("gopher://cards.bank.example/")).toBeDefined();
  });

  it("refuses an address with a credential in it", () => {
    expect(endpointProblem("https://user:secret@cards.bank.example/v1")).toMatch(/credential/i);
  });

  it("refuses an address pointed at this machine by name", () => {
    for (const endpoint of [
      "https://localhost/v1",
      "https://api.localhost/v1",
      "https://bankone.internal/v1",
      "https://printer.local/v1",
    ]) {
      expect(endpointProblem(endpoint)).toBeDefined();
    }
  });

  it("refuses a private address written as a literal", () => {
    expect(endpointProblem("https://127.0.0.1:8080/admin")).toBeDefined();
    expect(endpointProblem("https://169.254.169.254/latest/meta-data/")).toBeDefined();
    expect(endpointProblem("https://[::1]/admin")).toBeDefined();
  });

  it("refuses something that is not an address", () => {
    expect(endpointProblem("cards.bank.example/v1")).toBeDefined();
    expect(endpointProblem("")).toBeDefined();
  });

  /**
   * **A name that reads safely here proves nothing**, which is why this file's
   * check is the cheap one and the real deny lives at connect time on the
   * resolved address. Registering a public-looking hostname is allowed; what it
   * resolves to when the call is made is checked again, every time.
   */
  it("accepts a hostname whose address it cannot know yet", () => {
    expect(endpointProblem("https://whatever.example/v1")).toBeUndefined();
  });
});

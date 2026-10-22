import { describe, expect, it } from "vitest";

import { PinnedHttpsDispatcher, redirectProblem } from "./dispatcher";

const call = (endpoint = "https://cards.bank.example/v1/block") => ({
  endpoint,
  headers: { authorization: "Bearer bank-secret" },
  body: { account_number: "0123456789", parameters: {} },
});

/** A resolver that answers with whatever a test says the name points at. */
const resolvesTo = (...addresses: string[]) => {
  const calls: string[] = [];
  return {
    calls,
    resolve: async (hostname: string) => {
      calls.push(hostname);
      return addresses.map((address) => ({
        address,
        family: address.includes(":") ? 6 : 4,
      }));
    },
  };
};

describe("the call that is made", () => {
  /**
   * **The whole ticket in one test.** The name reads perfectly at registration
   * and points inside the Bank's network when the call is made, which is
   * exactly the case a URL validator declares safe.
   */
  it("refuses a hostname that resolves privately at call time", async () => {
    const resolver = resolvesTo("10.0.0.5");
    const dispatcher = new PinnedHttpsDispatcher({ resolve: resolver.resolve });

    const outcome = await dispatcher.send(call());

    expect(outcome).toMatchObject({ outcome: "refused" });
    expect(outcome).toMatchObject({ problem: expect.stringContaining("10.0.0.5") });
  });

  it("refuses the cloud metadata address, which is the one that hands out keys", async () => {
    const dispatcher = new PinnedHttpsDispatcher({ resolve: resolvesTo("169.254.169.254").resolve });

    expect(await dispatcher.send(call())).toMatchObject({ outcome: "refused" });
  });

  it("refuses loopback dressed as IPv6", async () => {
    const dispatcher = new PinnedHttpsDispatcher({ resolve: resolvesTo("::ffff:127.0.0.1").resolve });

    expect(await dispatcher.send(call())).toMatchObject({ outcome: "refused" });
  });

  /**
   * A name that answers with one good address and one bad one reaches the Bank's
   * network on whichever the resolver hands over next, so every address is
   * judged rather than the one this call happens to use.
   */
  it("refuses a name that answers with a private address beside a public one", async () => {
    const dispatcher = new PinnedHttpsDispatcher({
      resolve: resolvesTo("203.0.113.7", "192.168.1.10").resolve,
    });

    expect(await dispatcher.send(call())).toMatchObject({ outcome: "refused" });
  });

  it("refuses plain HTTP before it resolves anything at all", async () => {
    const resolver = resolvesTo("203.0.113.7");
    const dispatcher = new PinnedHttpsDispatcher({ resolve: resolver.resolve });

    expect(await dispatcher.send(call("http://cards.bank.example/v1"))).toMatchObject({
      outcome: "refused",
    });
    expect(resolver.calls).toEqual([]);
  });

  /**
   * **Resolved once.** The address the check ran against is the address the
   * socket connects to, so a record that changes in between changes nothing.
   */
  it("resolves the name exactly once, however the call ends", async () => {
    const resolver = resolvesTo("198.51.100.7");
    const dispatcher = new PinnedHttpsDispatcher({ resolve: resolver.resolve, timeoutMs: 150 });

    const outcome = await dispatcher.send(call());

    // Nobody answers at a documentation address, which is the point: what is
    // asserted is that it was reached for once and never looked up again.
    expect(outcome.outcome).toBe("unreachable");
    expect(resolver.calls).toEqual(["cards.bank.example"]);
  });

  it("says so plainly when the name does not resolve", async () => {
    const dispatcher = new PinnedHttpsDispatcher({
      resolve: async () => {
        throw new Error("ENOTFOUND");
      },
    });

    expect(await dispatcher.send(call())).toMatchObject({ outcome: "unreachable" });
  });
});

describe("a redirect", () => {
  it("is refused rather than followed", () => {
    expect(redirectProblem(302, "http://169.254.169.254/latest/meta-data/")).toMatch(
      /never followed/i,
    );
    expect(redirectProblem(301, undefined)).toBeDefined();
    expect(redirectProblem(307, "https://elsewhere.example/")).toBeDefined();
  });

  it("is told apart from the Bank's endpoint simply saying no", () => {
    expect(redirectProblem(200, undefined)).toBeUndefined();
    expect(redirectProblem(404, undefined)).toBeUndefined();
    expect(redirectProblem(500, undefined)).toBeUndefined();
  });
});

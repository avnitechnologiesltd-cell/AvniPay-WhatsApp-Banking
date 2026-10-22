import { describe, expect, it } from "vitest";

import {
  HANDOFF_TRIGGERS,
  HANDOFF_WORDS,
  PLATFORM_TRIGGERS,
  WHATSAPP_WINDOW_MS,
  pagesOperations,
  urgencyOf,
  waitsForBusinessHours,
  windowIsOpen,
} from "./handoff";

/**
 * The vocabulary, held to what the ticket settled.
 *
 * These are the claims that are cheapest to break by accident and most
 * expensive to notice: a seventh trigger appearing, the queue order drifting so
 * a stuck transfer sits behind a rephrase, or the Platform quietly gaining the
 * ability to claim a trigger it cannot observe.
 */

describe("the six triggers", () => {
  it("are six, and none of them is sentiment", () => {
    expect(HANDOFF_TRIGGERS).toEqual([
      "pending_transfer",
      "customer_asked",
      "gated_pin_failed",
      "agent_unable",
      "channel_cannot_fulfil",
      "repeated_failure",
    ]);

    // It was on the ticket and it does not survive: a second model judgement
    // stacked on one already measured at ~68%, whose failure mode is bad in
    // both directions. `repeated_failure` catches the real cases by observing
    // what happened instead of inferring how somebody feels.
    expect(HANDOFF_TRIGGERS.join(" ")).not.toMatch(/sentiment|frustrat|angry|mood/i);
  });

  it("put a stuck transfer at the top of the queue, always", () => {
    // Money has left the Customer's account and the platform cannot say where
    // it went. Nothing outranks that, and arrival order does not change it.
    const ranked = [...HANDOFF_TRIGGERS].sort((a, b) => urgencyOf(a) - urgencyOf(b));
    expect(ranked[0]).toBe("pending_transfer");
  });

  it("rank a Customer asking for a human above the Agent giving up", () => {
    expect(urgencyOf("customer_asked")).toBeLessThan(urgencyOf("agent_unable"));
  });

  it("rank every trigger distinctly, so the order is total", () => {
    const ranks = HANDOFF_TRIGGERS.map(urgencyOf);
    expect(new Set(ranks).size).toBe(HANDOFF_TRIGGERS.length);
  });
});

describe("what the Platform may claim", () => {
  it("is the four it can honestly observe", () => {
    expect(PLATFORM_TRIGGERS).toEqual([
      "customer_asked",
      "agent_unable",
      "channel_cannot_fulfil",
      "repeated_failure",
    ]);
  });

  it("excludes the two the Middleware alone can see", () => {
    // The Platform never sees a Transaction PIN and never dispatches a
    // transfer. A route that let it claim either would let a Customer's text
    // page the Bank's operations desk with a sentence.
    const claimable: readonly string[] = PLATFORM_TRIGGERS;
    expect(claimable).not.toContain("pending_transfer");
    expect(claimable).not.toContain("gated_pin_failed");
  });

  it("is a subset of the six, so the two lists cannot drift apart", () => {
    const all: readonly string[] = HANDOFF_TRIGGERS;
    for (const trigger of PLATFORM_TRIGGERS) expect(all).toContain(trigger);
  });
});

describe("what waits for business hours, and what wakes somebody up", () => {
  it("makes every trigger but a stuck transfer wait for opening time", () => {
    for (const trigger of HANDOFF_TRIGGERS) {
      expect(waitsForBusinessHours(trigger)).toBe(trigger !== "pending_transfer");
    }
  });

  it("pages the Bank for a stuck transfer and for nothing else", () => {
    for (const trigger of HANDOFF_TRIGGERS) {
      expect(pagesOperations(trigger)).toBe(trigger === "pending_transfer");
    }
  });

  it("keeps the two questions apart rather than deriving one from the other", () => {
    // They agree today and they are not the same fact. *When will somebody look
    // at this* and *is somebody woken up* answering through one predicate is how
    // the second silently changes with the first.
    for (const trigger of HANDOFF_TRIGGERS) {
      expect(pagesOperations(trigger)).toBe(!waitsForBusinessHours(trigger));
    }
  });
});

describe("WhatsApp's window", () => {
  const opened = new Date("2026-08-19T09:00:00Z");

  it("is twenty-four hours, and Meta's rather than ours", () => {
    expect(WHATSAPP_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("is open a minute before it closes and shut a minute after", () => {
    expect(windowIsOpen(opened, new Date(opened.getTime() + WHATSAPP_WINDOW_MS - 60_000))).toBe(
      true,
    );
    expect(windowIsOpen(opened, new Date(opened.getTime() + WHATSAPP_WINDOW_MS + 60_000))).toBe(
      false,
    );
  });

  it("is shut exactly on the boundary", () => {
    expect(windowIsOpen(opened, new Date(opened.getTime() + WHATSAPP_WINDOW_MS))).toBe(false);
  });
});

describe("what the Customer is told, in both directions", () => {
  it("names the Officer and the Bank on arrival", () => {
    expect(HANDOFF_WORDS.officerArrived("Amaka", "Example MFB")).toBe(
      "You're now speaking with Amaka from Example MFB.",
    );
  });

  it("names the Officer again on resolve, and says the Agent is back", () => {
    // Never silent, in either direction. Swapping a human for an AI without
    // saying so is a disclosure problem for a licensed institution.
    expect(HANDOFF_WORDS.officerResolved("Amaka")).toContain("Amaka");
    expect(HANDOFF_WORDS.officerResolved("Amaka")).toContain("I'm back");
  });
});

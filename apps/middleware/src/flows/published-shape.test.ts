import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { forPublishedFlow } from "./published-shape";

/**
 * The padding table is a copy of a contract that lives in Meta. These hold it
 * against the JSON we publish, so the copy cannot rot silently — which it
 * otherwise would, because nothing else in this repository fails when a screen
 * gains a field.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

const publishedScreens = (): { id: string; data: Record<string, { type: string }> }[] =>
  ["enrollment", "send-money"].flatMap((name) => {
    const flow = JSON.parse(
      readFileSync(join(REPO_ROOT, "docs/reference/flows", `${name}.flow.json`), "utf8"),
    ) as { screens: { id: string; data?: Record<string, { type: string }> }[] };
    return flow.screens.map((screen) => ({ id: screen.id, data: screen.data ?? {} }));
  });

describe("what a published Flow declares", () => {
  it("is exactly what the padding sends, for every screen", () => {
    const mismatches: string[] = [];

    for (const screen of publishedScreens()) {
      const padded = forPublishedFlow({ screen: screen.id, data: {}, terminal: false });
      const sent = new Set(Object.keys(padded.data));
      const declared = new Set(Object.keys(screen.data));

      for (const key of declared) {
        if (!sent.has(key)) mismatches.push(`${screen.id} declares ${key}, nothing sends it`);
      }
      for (const key of sent) {
        if (!declared.has(key)) mismatches.push(`${screen.id} sends ${key}, the Flow declares no such field`);
      }
    }

    expect(mismatches).toEqual([]);
  });

  it("sends a boolean for every field a screen binds `visible` to", () => {
    // The publish-time refusal this exists to prevent, verbatim: "Expected
    // 'screens[0].data.error_message' to be of type 'boolean'."
    const wrong: string[] = [];

    for (const screen of publishedScreens()) {
      const padded = forPublishedFlow({ screen: screen.id, data: {}, terminal: false });
      for (const [key, declaration] of Object.entries(screen.data)) {
        if (declaration.type !== "boolean") continue;
        if (typeof padded.data[key] !== "boolean") {
          wrong.push(`${screen.id}.${key} is declared boolean, ${typeof padded.data[key]} sent`);
        }
      }
    }

    expect(wrong).toEqual([]);
  });

  it("reports a key as present only when it carries something", () => {
    const empty = forPublishedFlow({ screen: "IDENTIFY", data: {}, terminal: false });
    expect(empty.data["error_message"]).toBe("");
    expect(empty.data["has_error_message"]).toBe(false);

    const refused = forPublishedFlow({
      screen: "IDENTIFY",
      data: { error_message: "Please check it." },
      terminal: false,
    });
    expect(refused.data["has_error_message"]).toBe(true);

    // An empty list is a screen with no rows to offer, not a screen with rows.
    const none = forPublishedFlow({ screen: "RECIPIENT", data: {}, terminal: false });
    expect(none.data["has_beneficiaries"]).toBe(false);
  });

  it("leaves a screen it does not know completely alone", () => {
    const unknown = forPublishedFlow({ screen: "NOT_A_SCREEN", data: { a: 1 }, terminal: false });
    expect(unknown.data).toEqual({ a: 1 });
  });

  it("keeps what the state machine supplied", () => {
    const confirm = forPublishedFlow({
      screen: "CONFIRM",
      data: { amount: "₦5,000.00", destination_name: "MUSA ADEYEMI" },
      terminal: false,
    });

    expect(confirm.data["amount"]).toBe("₦5,000.00");
    expect(confirm.data["has_amount"]).toBe(true);
    // The Gated Connector's half of this shared screen, absent on a transfer.
    expect(confirm.data["action"]).toBe("");
    expect(confirm.data["has_action"]).toBe(false);
  });
});

import type { FlowScreen } from "./screen";

/**
 * What a **published Flow** requires of a screen's data, which is more than the
 * state machines have any reason to know.
 *
 * Two rules come from Meta rather than from us, and both are enforced here so
 * that no service has to learn them:
 *
 * 1. **Every key the screen declares must be present.** A published Flow
 *    validates a `data_exchange` response against the screen's declared model.
 *    The services send a key only when it applies — an `error_message` after a
 *    refusal, an `amount` when the walk has one — which is the right shape for
 *    the Widget and the wrong shape for Meta.
 * 2. **`visible` must resolve to a boolean.** Binding it to a string is
 *    rejected at publish time with *"Expected … to be of type 'boolean'"*. So
 *    for every declared key `k` this also sends `has_k`, and the screens bind
 *    their conditional rendering to that.
 *
 * It runs on the WhatsApp path only. **The Widget renders the same screens and
 * needs none of this** — it has no published schema to satisfy — so padding it
 * would be inventing a constraint on the Channel that does not have one.
 */

/**
 * Every key each published screen declares, with what to send when the state
 * machine did not.
 *
 * This is a copy of a contract that lives in Meta, which is a fact worth being
 * uncomfortable about: the source of truth is
 * `docs/reference/flows/*.flow.json`, and `flows.controller.test.ts` checks
 * this table against those files so the two cannot drift silently.
 */
const DECLARED: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  // --- Enrollment ------------------------------------------------------------
  IDENTIFY: { error_message: "" },
  CHOOSE_DESTINATION: { destinations: [] },
  CODE: { error_message: "" },
  SET_PIN: { error_message: "" },

  // --- Send money, and the Gated Connector surface that shares CONFIRM -------
  RECIPIENT: { purpose: "", beneficiaries: [], amount: "", error_message: "" },
  CONFIRM: {
    amount: "",
    destination_name: "",
    destination_account: "",
    destination_bank: "",
    source_account: "",
    fee_note: "",
    // The Gated Connector surface sends these two instead of the six above.
    action: "",
    details: "",
    pin_action: "",
    pin_note: "",
    name_changed: "",
    error_message: "",
  },

  // --- Terminal, on both Flows ----------------------------------------------
  DONE: { message: "" },
  LOCKED: { message: "" },
  UNAVAILABLE: { message: "" },
} as const;

/** Present *and* carrying something. An empty string is a key with no content. */
const hasContent = (value: unknown): boolean => {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null && value !== false;
};

/**
 * The screen as a published Flow needs to receive it.
 *
 * A screen id this does not know is passed through untouched rather than
 * emptied — being wrong about the shape is worse than not knowing it, and an
 * unknown id is already handled as a refusal further up.
 */
export const forPublishedFlow = (screen: FlowScreen): FlowScreen => {
  const declared = DECLARED[screen.screen];
  if (!declared) return screen;

  const data: Record<string, unknown> = {};
  for (const [key, fallback] of Object.entries(declared)) {
    const value = screen.data[key] ?? fallback;
    data[key] = value;
    data[`has_${key}`] = hasContent(value);
  }
  return { ...screen, data };
};

/** The table above, for the test that holds it against the published JSON. */
export const declaredScreenData = DECLARED;

/**
 * What a sealed surface renders, whichever walk the Customer is on.
 *
 * Enrollment and a transfer are two different published Flows with two different
 * screen sets, and neither knows about the other. What they share is this shape,
 * which is all the Flows endpoint needs to seal an answer — the endpoint routes
 * an exchange and encrypts the reply, and has no opinion about what is on the
 * screen.
 */
export interface FlowScreen {
  readonly screen: string;
  readonly data: Readonly<Record<string, unknown>>;
  /** Terminal screens end the Flow; nothing follows them. */
  readonly terminal: boolean;
}

/**
 * What a sealed surface says when it cannot go on: one sentence, for every
 * cause.
 *
 * Expired, forged, finished, never-minted and *belonging to a walk this endpoint
 * no longer has* are one answer. A handset that could tell them apart would have
 * an oracle for the price of a guessed token, and none of the five is a state a
 * real one reaches.
 */
export const SURFACE_UNAVAILABLE = "We cannot do that just now. Please try again shortly.";

/**
 * One string out of what a handset sent. Anything else — a number, an object, a
 * missing key — reads as absent.
 *
 * It is here rather than beside either caller because both the endpoint and the
 * state machines behind it read payloads, and two readings of *"what did the
 * handset supply for this field"* is one more than the number of answers there
 * should be.
 */
export const readText = (data: Readonly<Record<string, unknown>>, key: string): string =>
  typeof data[key] === "string" ? (data[key] as string) : "";

export const unavailableScreen = (
  message: string = SURFACE_UNAVAILABLE,
): FlowScreen & { readonly screen: "UNAVAILABLE" } => ({
  screen: "UNAVAILABLE",
  data: { message },
  terminal: true,
});

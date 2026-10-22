import type { SealedSurfaceAddress } from "@avni/intent";

/**
 * The normalised message shape, and the one distinction the whole channel layer
 * exists to preserve.
 *
 * Inbound splits **three** ways, not one:
 *
 * - **`said`** — free text a Customer composed. **The only thing the model is
 *   ever shown**, and therefore the platform's injection surface.
 * - **`chose`** — an identifier the platform minted, returned unchanged by the
 *   handset. Routed by code, never by a model.
 * - **`event`** — inbound but not a message: a completed Flow's reply, a
 *   delivery receipt. The Orchestration Layer never sees one.
 *
 * Flattened to a single string — which is what the prior art does — a Customer
 * who *types* the literal `menu_transfer` becomes indistinguishable from one
 * who *tapped* that button, and every handler downstream has to defend itself.
 */

export type Channel = "whatsapp" | "in_app_chat";

interface InboundBase {
  readonly channel: Channel;
  /** The WhatsApp number, or whatever names the correspondent on this Channel. */
  readonly channelIdentity: string;
  /** The Channel's own id for this message, for deduplication and audit. */
  readonly externalId: string;
}

/**
 * A file the Customer sent, as this layer is permitted to know it.
 *
 * **An id, a type and a name. Never contents, and never a path to contents.** A
 * Customer photographing a receipt is ordinary support and refusing attachments
 * outright is not usable for a bank — but a document handed to the layer running
 * the LLM is an injection vector with a file extension, and the Customer chooses
 * the filename too. So the bytes are moved into object storage without being
 * opened, and what survives into the conversation is the fact that a file
 * exists (ticket 11).
 */
export interface Attachment {
  /** WhatsApp's media id, exchanged for bytes and then discarded. */
  readonly mediaId: string;
  readonly mediaType: string;
  /** The Customer's own filename. Rendered to an Officer; never used as a key. */
  readonly filename: string;
}

export interface Said extends InboundBase {
  readonly kind: "said";
  readonly text: string;
  /**
   * Present when the Customer sent a file. **Its presence alone takes the whole
   * message off the model's path** — caption included, because a caption beside
   * a document is the most natural place in the product to put an instruction
   * you want a model to read.
   */
  readonly attachment?: Attachment;
}

export interface Chose extends InboundBase {
  readonly kind: "chose";
  /** An id *we* minted and rendered. Never parsed as if it were words. */
  readonly id: string;
}

export interface InboundEvent extends InboundBase {
  readonly kind: "event";
  readonly event: "delivery_receipt" | "flow_reply";
  readonly detail: Readonly<Record<string, unknown>>;
}

export type Inbound = Said | Chose | InboundEvent;

/**
 * Outbound: **the composer describes and the adapter renders.**
 *
 * There is no capability negotiation anywhere. The caller is partly an LLM, and
 * capability flags would be reasoning we can delete rather than debug.
 *
 * `typing` is deliberately absent — it is a Channel affordance, not a reply,
 * and the adapter does it unprompted.
 */
export interface Say {
  readonly verb: "say";
  readonly text: string;
}

export interface Ask {
  readonly verb: "ask";
  readonly question: string;
  /** Each choice carries the id the handset will send back as a `chose`. */
  readonly choices: readonly { readonly id: string; readonly label: string }[];
}

export interface Send {
  readonly verb: "send";
  readonly documentUrl: string;
  readonly caption?: string;
}

/**
 * *"Deliver this sealed authorisation surface on whatever Channel they are on."*
 *
 * Its caller is the **Middleware**, not the Support Agent — a Flow on WhatsApp,
 * a Widget in the app, and the value never in the transcript either way. The
 * Platform is a courier that cannot open the envelope.
 */
export interface Secure extends SealedSurfaceAddress {
  readonly verb: "secure";
  /** The words beside the button. Never the value the surface will collect. */
  readonly purpose: string;
  /** What the button says. */
  readonly callToAction: string;
}

export type Outbound = Say | Ask | Send | Secure;

export const say = (text: string): Say => ({ verb: "say", text });

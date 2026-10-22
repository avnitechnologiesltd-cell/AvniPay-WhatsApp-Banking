import type { ConnectorsService } from "../connectors/connectors.service";
import type { Channel } from "../identity/conversations.service";
import type { TransfersService } from "../transfers/transfers.service";
import { readText, unavailableScreen, type FlowScreen } from "../flows/screen";

/**
 * One step of a sealed surface, in the platform's own words rather than in
 * Meta's.
 *
 * A **Flow** and a **Widget** render the same screens and take the same steps —
 * that is the whole of *"same bot logic, different rendering"* — so the exchange
 * between a handset and the Middleware is one shape with two doors. WhatsApp's
 * door translates Meta's `flow_token` into the `token` below; the Widget's door
 * speaks this directly. What is behind both is `transferScreenFor`, and there is
 * only one of it.
 *
 * `screen` names the screen the Customer just **left**, which is how a single
 * `data_exchange` action carries every step of every walk. It is a value the
 * handset supplies, so it is a request rather than a fact: the state machine
 * behind it refuses any step that does not match the state it is in.
 */
export interface SurfaceExchange {
  readonly action: string;
  readonly screen: string;
  /**
   * Names the walk or the Mandate. Minted by the Middleware, opaque everywhere
   * else, and **the only thing that decides what this exchange is about**.
   */
  readonly token?: string | undefined;
  /**
   * What the handset sent up.
   *
   * **The payload rule this whole design rests on:** it may carry what the
   * Customer *newly supplies* — a typed account number, a row they tapped, a
   * PIN, a label — and it must **never** carry back a value the server
   * rendered. A Flow encrypts with a key the client generates and a Widget runs
   * inside an application we do not build, so the handset owns this plaintext
   * entirely either way; a server that read a rendered value out of it would
   * have let the phone decide what it is agreeing to.
   *
   * Nothing reached from here names an amount, and nothing names an account
   * number after the screen the Customer typed it on. Which transfer is being
   * authorised is read from what the token points at, so a tampered later
   * payload changes nothing — not because it is checked and rejected, but
   * because nothing looks at it.
   */
  readonly data: Readonly<Record<string, unknown>>;
}

/**
 * The two state machines a sealed surface can be driving.
 *
 * A pair rather than a growing argument list, because the door does not choose
 * between them — **the token does**. Both doors hand the same pair over and ask
 * the same two questions, which is what keeps *"a handset cannot name the
 * machine it wants"* true as a second machine arrives.
 */
export interface SealedSurfaces {
  readonly transfers: TransfersService;
  readonly connectors: ConnectorsService;
}

/** The conversation a sealed surface belongs to, and the Channel it is on. */
export interface SealedSurfaceOwner {
  readonly conversationId: string;
  readonly channel: Channel;
  /**
   * **Which machine the token names**, resolved once and carried.
   *
   * Both doors already have to ask *whose surface is this* before they will
   * drive it, and the answer to that is also the answer to *which state machine
   * this exchange belongs to* — so it is read out of the same lookup rather
   * than a second one. Carrying it is also what keeps the routing honest: the
   * screen id the handset claims to be on is never consulted, because a
   * transfer and a Gated Connector both end at `CONFIRM`.
   */
  readonly surface: "transfer" | "connector";
}

/**
 * Whose surface a token names, across every machine that mints one.
 *
 * Each door asks this and drives only its own Channel's surfaces. A token minted
 * on WhatsApp cannot be authorised through the Widget or the other way round —
 * in either direction, because the argument is symmetric and a door that trusted
 * the asymmetry would be trusting Meta's app secret to stay secret forever.
 *
 * `undefined` means *nothing answers to this token*, which every caller treats
 * exactly as it treats the wrong Channel: expired, forged, finished and
 * belonging-somewhere-else are one answer, because a handset that could tell
 * them apart would have an oracle for the price of a guessed token.
 */
export const sealedSurfaceOwner = async (
  surfaces: SealedSurfaces,
  token: string | undefined,
): Promise<SealedSurfaceOwner | undefined> => {
  const transfer = await surfaces.transfers.surfaceOwner(token);
  if (transfer) return { ...transfer, surface: "transfer" };

  const connector = await surfaces.connectors.surfaceOwner(token);
  return connector ? { ...connector, surface: "connector" } : undefined;
};

/**
 * One step of whichever surface the token names.
 *
 * **Resolved from the token before a screen id is read**, and that order is the
 * security property rather than tidiness: the two machines share the `CONFIRM`
 * screen — a transfer and a Gated Connector both end at *enter your Transaction
 * PIN* — so a router that dispatched on the screen the handset claimed to be on
 * would let a payload choose which one it was authorising.
 *
 * `undefined` means *no surface here handles this*, and the two doors answer it
 * differently: the Flows endpoint offers the exchange to enrollment, and the
 * Widget has nowhere to fall through to because **in-app chat has no
 * enrollment**.
 */
export const sealedScreenFor = async (
  surfaces: SealedSurfaces,
  exchange: SurfaceExchange,
  /**
   * Who owns the token, from the check the door has already made. Both doors
   * refuse an exchange whose owner is on the other Channel, so by the time this
   * is called the answer is in hand — asking again would be a second lookup for
   * a question already answered.
   */
  owner: SealedSurfaceOwner | undefined,
): Promise<FlowScreen | undefined> =>
  owner?.surface === "connector"
    ? connectorScreenFor(surfaces.connectors, exchange)
    : transferScreenFor(surfaces.transfers, exchange);

/**
 * The Gated Connector surface: the same two steps a transfer's Confirmation
 * screen has, minus everything that was about money.
 *
 * It renders through the **transaction PIN Flow** rather than a published Flow
 * of its own (ADR-0009), so the screen ids are the ones that Flow already
 * declares. What the Customer is authorising is rendered from the stored
 * request; the payload carries the four digits they just typed and nothing else.
 */
const connectorScreenFor = async (
  connectors: ConnectorsService,
  exchange: SurfaceExchange,
): Promise<FlowScreen> => {
  if (exchange.action === "INIT" || exchange.action === "BACK") {
    return (await connectors.open(exchange.token)) ?? unavailableScreen();
  }
  if (exchange.action !== "data_exchange") return unavailableScreen();

  return exchange.screen === "CONFIRM"
    ? ((await connectors.submitPin(exchange.token, readText(exchange.data, "pin"))) ??
        unavailableScreen())
    : unavailableScreen();
};

/**
 * The transfer surface, on whichever Channel asked for it.
 *
 * A function taking the service rather than a method on it, because what is
 * here is **wire protocol** — Meta's action names and the screen ids a
 * published Flow uses — and the service owns the state machine rather than the
 * envelope it arrives in. Both doors translate their own request into this
 * shape; neither makes `TransfersService` learn a screen id.
 *
 * `undefined` means *no screen here handles this*, and the two doors answer it
 * differently: the Flows endpoint offers the exchange to enrollment, which is
 * the other machine published on that Channel, and the Widget has nowhere to
 * fall through to because **in-app chat has no enrollment**
 * ([ADR-0010](../../../../docs/adr/0010-the-in-app-chat-snippet-carries-a-signed-identity.md)).
 */
export const transferScreenFor = async (
  transfers: TransfersService,
  exchange: SurfaceExchange,
): Promise<FlowScreen | undefined> => {
  // Opening the surface, and going back a screen inside it, both mean "render
  // where I am". The state machine is the only thing that knows where that is.
  if (exchange.action === "INIT" || exchange.action === "BACK") {
    return transfers.open(exchange.token);
  }
  if (exchange.action !== "data_exchange") return undefined;

  switch (exchange.screen) {
    case "RECIPIENT":
      // **The Disambiguation screen**, and the account-number form beneath it.
      // Everything read here is something the Customer newly supplied — a row
      // they tapped, ten digits they typed, a bank they named — and the amount
      // is not among them: it was rendered from the walk this token names, and
      // is read back from there.
      return (
        (await transfers.chooseBeneficiary(exchange.token, exchange.data)) ?? unavailableScreen()
      );

    case "CONFIRM":
      // **Three values, and every one of them is a thing the Customer typed.**
      // The Transaction PIN, its confirmation on the surface that *creates*
      // one, and an optional label for a recipient they are about to pay. Not
      // the amount, not the account number, not the recipient's name — those
      // are rendered from the Mandate and never sent back, which is what makes
      // echoing a tampered one pointless rather than refused.
      //
      // The label is captured here rather than asked for in conversation
      // because a Customer replying `Musa` to a question is indistinguishable
      // from a malformed Intent to the model that would read it. Captured on
      // this screen, the one Customer-typed string the resolver later searches
      // never passes through the Platform or the model at all.
      return (
        (await transfers.submitPin(exchange.token, {
          pin: readText(exchange.data, "pin"),
          pinConfirmation: readText(exchange.data, "pin_confirmation"),
          saveAs: readText(exchange.data, "save_as"),
        })) ?? unavailableScreen()
      );

    default:
      return undefined;
  }
};

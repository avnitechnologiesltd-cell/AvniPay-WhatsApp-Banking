import { Body, Controller, Header, HttpCode, Inject, Logger, Options, Post } from "@nestjs/common";
import { z } from "zod";

import { AuditRepository } from "../audit/audit.repository";
import { ConnectorsService } from "../connectors/connectors.service";
import { unavailableScreen, type FlowScreen } from "../flows/screen";
import { TransfersService } from "../transfers/transfers.service";
import { WIDGET_SURFACE_PATH } from "./address";
import { sealedScreenFor, sealedSurfaceOwner } from "./exchange";

/**
 * What a handset may send.
 *
 * Deliberately the same four fields the Flows endpoint reads, in the platform's
 * own words rather than Meta's — one exchange with two doors. What a `data`
 * payload may and may not carry is the rule in `exchange.ts`, and it is not
 * relaxed here: **values the server rendered are never read back**, on either
 * Channel.
 */
const surfaceRequest = z.object({
  action: z.string().default(""),
  screen: z.string().default(""),
  token: z.string().optional(),
  data: z.record(z.unknown()).default({}),
});

/**
 * The **Widget's** sealed surface — the Middleware's second inbound path from
 * the public internet, and in-app chat's counterpart to a Flow.
 *
 * Everything a Flow renders is rendered here: the Confirmation screen, the
 * Disambiguation screen, the *"Save as"* field, PIN entry and — the one thing a
 * Flow never carries — PIN **creation**. The screens are not re-implemented for
 * this Channel; `transferScreenFor` is the same function the Flows endpoint
 * calls, so *"same bot logic, different rendering"* is what the code does
 * rather than what it aspires to.
 *
 * **It is here and not in the Platform**, and the reason is stronger than it is
 * for a Flow ([ADR-0007](../../../../docs/adr/0007-flow-confirmations-terminate-at-the-middleware.md),
 * [ADR-0010](../../../../docs/adr/0010-the-in-app-chat-snippet-carries-a-signed-identity.md)).
 * A Flow carries a Transaction PIN the Customer already had; this also carries
 * the moment they choose one. The Platform serves the Widget's code and never
 * sees a single value it collects, and those two facts together are what make
 * it safe for the prompt-injection surface to serve it at all.
 *
 * ## What is different from the Flows endpoint, and what is not
 *
 * **Not encrypted, and it does not need to be.** A Flow's payload is sealed
 * because it travels through Meta; this one is ordinary HTTPS from a handset to
 * us, with nobody in between to keep out. The Flows keypair exists to exclude a
 * third party from the conversation, and on this Channel there is no third
 * party.
 *
 * **No enrollment behind it.** The Flows endpoint falls through to the
 * enrollment machine; there is nothing here to fall through to, because in-app
 * chat has no Binding, no OTP and no enrollment at all.
 *
 * **The token must belong to this Channel.** Both doors ask, and neither drives
 * the other's surfaces.
 */
@Controller(WIDGET_SURFACE_PATH)
export class WidgetSurfaceController {
  private readonly logger = new Logger(WidgetSurfaceController.name);

  public constructor(
    @Inject(TransfersService) private readonly transfers: TransfersService,
    @Inject(ConnectorsService) private readonly connectors: ConnectorsService,
    @Inject(AuditRepository) private readonly audit: AuditRepository,
  ) {}

  /**
   * The browser's permission question, answered once per surface.
   *
   * The Widget is served by the Platform and posts here, so every one of these
   * requests is cross-origin by construction — that separation is the design,
   * and this is what it costs. **Any origin, and no credentials**: the Widget
   * runs inside a WebView in an application we do not build, whose origin may be
   * the Bank's own scheme or `null`, so an allow-list would be a list of
   * everybody. Nothing here is authorised by anything the browser attaches; the
   * only credential is the token in the body, which a cross-origin page cannot
   * obtain by making this request.
   */
  @Options()
  @HttpCode(204)
  @Header("access-control-allow-origin", "*")
  @Header("access-control-allow-methods", "POST, OPTIONS")
  @Header("access-control-allow-headers", "content-type")
  @Header("access-control-max-age", "86400")
  public preflight(): void {}

  @Post()
  @HttpCode(200)
  @Header("access-control-allow-origin", "*")
  @Header("cache-control", "no-store")
  public async exchange(@Body() body: unknown): Promise<FlowScreen> {
    const parsed = surfaceRequest.safeParse(body);
    if (!parsed.success) {
      return this.refuse(undefined, "(malformed)", "(malformed)", "the body did not parse");
    }

    // **A token from the other Channel is refused here.** A WhatsApp transfer
    // is authorised inside a payload Meta signed and encrypted; this endpoint
    // has neither in front of it, so without this check it would be a second,
    // weaker door onto the same Mandate — reachable by a handset that never
    // presented a signed identity and holds no Binding.
    //
    // A token naming nothing gets the same answer, because expired, forged,
    // finished and belonging-to-WhatsApp are one sentence. A handset that could
    // tell them apart would have an oracle for the price of a guessed token.
    const surfaces = { transfers: this.transfers, connectors: this.connectors };
    const owner = await sealedSurfaceOwner(surfaces, parsed.data.token);
    if (owner?.channel !== "in_app_chat") {
      return this.refuse(
        owner?.conversationId,
        parsed.data.action,
        parsed.data.screen,
        owner ? "that surface belongs to another Channel" : "no surface answers to that token",
      );
    }

    return (await sealedScreenFor(surfaces, parsed.data, owner)) ?? unavailableScreen();
  }

  /**
   * One sentence to the handset, and the reason to the Bank.
   *
   * The Customer reads *"we cannot do that just now"* whatever happened, and
   * which of the three it was lives in the audit table — the same arrangement
   * every refusal on the sealed channel is under. The conversation goes on the
   * row where there is one, because *whose* surface somebody reached for is the
   * question this row exists to answer.
   */
  private async refuse(
    conversationId: string | undefined,
    action: string,
    screen: string,
    reason: string,
  ): Promise<FlowScreen> {
    this.logger.warn({ event: "widget_surface_refused", action, screen, reason });
    await this.audit.record({
      action: "surface.refused",
      actor: { kind: "customer" },
      outcome: "refused",
      ...(conversationId ? { conversationId } : {}),
      detail: {
        // The door, not a claim about the token — a WhatsApp token refused here
        // was refused at the Widget's, and saying `channel: "in_app_chat"` of it
        // would have read as the opposite.
        surface: "widget",
        surfaceAction: action || "(none)",
        surfaceScreen: screen || "(none)",
        reason,
      },
    });

    return unavailableScreen();
  }
}

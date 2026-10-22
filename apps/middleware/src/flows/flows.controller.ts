import type { KeyObject } from "node:crypto";

import { Body, Controller, Headers, Inject, Logger, Post, Req, Res } from "@nestjs/common";
import type { OnModuleInit } from "@nestjs/common";
import type { Request, Response } from "express";
import { z } from "zod";

import type { MiddlewareConfig } from "@avni/config";

import { AuditRepository } from "../audit/audit.repository";
import { ConnectorsService } from "../connectors/connectors.service";
import { EnrollmentService } from "../enrollment/enrollment.service";
import { TransfersService } from "../transfers/transfers.service";
import { FLOWS_PRIVATE_KEY, MIDDLEWARE_CONFIG } from "../tokens";
import { FlowDecryptionError, decryptFlowRequest, encryptFlowResponse } from "./crypto";
import { sealedScreenFor, sealedSurfaceOwner, type SurfaceExchange } from "../surfaces/exchange";
import { forPublishedFlow } from "./published-shape";
import { readText, unavailableScreen, type FlowScreen } from "./screen";
import { flowSignatureNotice, signatureFailure } from "./signature";

/**
 * Meta's own status codes for a Flows endpoint. Answering the right one is not
 * cosmetic — `421` is what makes the client re-fetch our public key, which is
 * the whole recovery path after a key rotation.
 */
const KEY_REFRESH_REQUIRED = 421;
const SIGNATURE_REJECTED = 432;

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

/**
 * What a screen may send back, in **Meta's** field names.
 *
 * This is the WhatsApp door onto a surface both Channels share, so it is a
 * translation and nothing more: `flow_token` becomes `token` and the rest is
 * handed to `transferScreenFor` unchanged. The rule about what a payload may
 * carry lives with the exchange it constrains, in `surfaces/exchange.ts`.
 */
const flowPayload = z.object({
  action: z.string().default(""),
  screen: z.string().default(""),
  flow_token: z.string().optional(),
  version: z.unknown().optional(),
  data: z.record(z.unknown()).default({}),
});

/**
 * The Middleware's one inbound path from the public internet.
 *
 * It accepts only WhatsApp's encrypted payloads, verifies their signature, and
 * answers sealed. **The Platform has no route here and no key material** — a
 * Transaction PIN arriving through the layer that runs the LLM is the thing
 * [ADR-0007](../../../../docs/adr/0007-flow-confirmations-terminate-at-the-middleware.md)
 * exists to prevent, and enrollment is the first slice that actually carries one.
 */
@Controller("flows")
export class FlowsController implements OnModuleInit {
  private readonly logger = new Logger(FlowsController.name);

  public constructor(
    @Inject(MIDDLEWARE_CONFIG) private readonly config: MiddlewareConfig,
    @Inject(FLOWS_PRIVATE_KEY) private readonly privateKey: KeyObject,
    @Inject(AuditRepository) private readonly audit: AuditRepository,
    @Inject(EnrollmentService) private readonly enrollment: EnrollmentService,
    @Inject(TransfersService) private readonly transfers: TransfersService,
    @Inject(ConnectorsService) private readonly connectors: ConnectorsService,
  ) {}

  /**
   * Says whether this endpoint is verifying signatures, every time it starts.
   *
   * Logged rather than merely knowable, because the off state is a deliberate
   * operational choice that outlives whoever made it — and a deployment that
   * stopped checking in March is otherwise something someone has to remember.
   */
  public onModuleInit(): void {
    const notice = flowSignatureNotice(this.config.whatsapp.appSecret);
    if (notice.verifying) this.logger.log({ event: "flow_signature", ...notice });
    else this.logger.warn({ event: "flow_signature", ...notice });
  }

  /**
   * The response is written directly rather than returned.
   *
   * Two reasons, both about this endpoint's contract rather than convenience:
   * a success is a **bare base64 string**, not JSON, and a refusal must carry
   * **no body at all**. Nest's default envelope would wrap both.
   */
  @Post("whatsapp")
  public async exchange(
    @Req() request: RawBodyRequest,
    @Res() response: Response,
    @Body() body: unknown,
    @Headers("x-hub-signature-256") signature?: string,
  ): Promise<void> {
    // Verified against the raw bytes. Re-serialising the parsed object would
    // change key order and whitespace, and break for reasons that look like a
    // Meta outage rather than a bug here.
    const failure = signatureFailure(request.rawBody, signature, this.config.whatsapp.appSecret);
    if (failure) {
      // Named, because the two mean opposite things to whoever is reading this.
      // `absent` is a caller that is not Meta; `mismatched` is almost always
      // WHATSAPP_APP_SECRET being wrong or still a placeholder.
      return this.refuse(
        response,
        `the signature ${failure === "mismatched" ? "did not verify" : `was ${failure}`}`,
        SIGNATURE_REJECTED,
      );
    }

    let opened;
    try {
      opened = decryptFlowRequest(body, this.privateKey);
    } catch (error) {
      // Answering 421 asks the client to re-fetch our public key, which is the
      // recovery path after a rotation. The reason goes to the log and the
      // audit table; the caller learns only the code.
      return this.refuse(
        response,
        error instanceof FlowDecryptionError ? error.reason : "the payload did not open",
        KEY_REFRESH_REQUIRED,
      );
    }

    const parsed = flowPayload.safeParse(opened.payload);
    const payload = parsed.success
      ? parsed.data
      : { action: "", screen: "", data: {}, flow_token: undefined, version: undefined };

    // The health check Meta sends before it will publish a Flow, and
    // periodically afterwards. It carries no Customer data.
    if (payload.action === "ping") {
      this.seal(response, { data: { status: "active" } }, opened.aesKey, opened.initialVector);
      return;
    }

    const screen = await this.screenFor(payload);
    if (screen) {
      // Padded to what the published Flow declares, here and not in the state
      // machines — the Widget renders the same screens and needs none of it.
      const published = forPublishedFlow(screen);
      // **No top-level `version`.** A data-exchange response carries the screen
      // and its data and nothing else; the prior art says so in a comment and
      // has worked in production for longer than this file has existed.
      this.seal(
        response,
        { screen: published.screen, data: published.data },
        opened.aesKey,
        opened.initialVector,
      );
      return;
    }

    // A screen id neither state machine answers to, which a real handset does
    // not send. It is recorded and answered honestly rather than half-handled,
    // and the exchange stays sealed either way.
    this.logger.warn({ event: "flow_action_not_handled", action: payload.action });
    await this.audit.record({
      action: "flow.exchanged",
      actor: { kind: "customer" },
      outcome: "refused",
      detail: {
        flowAction: payload.action || "(none)",
        flowScreen: payload.screen || "(none)",
        reason: "no screen handles this yet",
      },
    });

    this.seal(
      response,
      { screen: "ERROR", data: { acknowledged: true } },
      opened.aesKey,
      opened.initialVector,
    );
  }

  /**
   * Routes one exchange to a state machine, or answers nothing.
   *
   * `screen` names the screen the Customer just left, which is how one
   * `data_exchange` action carries every step of every walk. It is a value the
   * handset supplies, so it is treated as a request rather than a fact: each
   * state machine refuses any step that does not match the state it is in.
   *
   * **Which walk a token belongs to is not read from the payload either.** The
   * transfer surface is asked first and answers `undefined` when the token
   * names no Mandate; enrollment then answers, and its own unknown-token
   * behaviour is unchanged. So a handset cannot name the machine it wants to be
   * routed to, any more than it can name the screen it is on.
   *
   * The first half of that is shared with the Widget and lives in
   * `surfaces/exchange.ts`. The second half is not: **in-app chat has no
   * enrollment**, so nothing below the fall-through is reachable from the other
   * Channel.
   */
  private async screenFor(payload: {
    action: string;
    screen: string;
    flow_token?: string | undefined;
    data: Record<string, unknown>;
  }): Promise<FlowScreen | undefined> {
    const token = payload.flow_token;
    const surfaceExchange: SurfaceExchange = {
      action: payload.action,
      screen: payload.screen,
      token,
      data: payload.data,
    };
    const surfaces = { transfers: this.transfers, connectors: this.connectors };

    // **A token from the other Channel is not driven here either**, and the
    // check is here rather than only at the Widget's door because the argument
    // is symmetric. Meta's signature makes reaching this endpoint hard rather
    // than impossible, and a rule that held in one direction because the other
    // door happened to be harder would be resting on an app secret staying
    // secret forever.
    //
    // `undefined` — a token naming no transfer at all — still goes through, so
    // an enrollment token reaches the machine below exactly as it always did.
    const owner = await sealedSurfaceOwner(surfaces, token);
    if (owner?.channel === "in_app_chat") {
      // The same sentence expiry, forgery and a finished walk get. Falling
      // through to enrollment would have answered a *different* screen, which
      // is an oracle: a handset could tell "that token is in-app chat's" from
      // "that token is spent" by reading which one came back.
      await this.audit.record({
        action: "surface.refused",
        actor: { kind: "customer" },
        outcome: "refused",
        conversationId: owner.conversationId,
        detail: {
          surface: "flow",
          surfaceAction: payload.action || "(none)",
          surfaceScreen: payload.screen || "(none)",
          reason: "that surface belongs to another Channel",
        },
      });
      return unavailableScreen();
    }

    // **The shared surfaces are asked first, and they are the same ones the
    // Widget drives.** A screen either of them handles is handled identically on
    // both Channels — that is what makes *"same bot logic, different rendering"*
    // a fact about the code rather than an intention. Which machine answers is
    // decided by what the token names, never by the screen id the handset sent.
    // What they decline falls through to enrollment, which is WhatsApp's alone.
    const shared = await sealedScreenFor(surfaces, surfaceExchange, owner);
    if (shared) return shared;

    if (payload.action === "INIT" || payload.action === "BACK") {
      return this.enrollment.open(token);
    }
    if (payload.action !== "data_exchange") return undefined;

    switch (payload.screen) {
      case "IDENTIFY":
        return this.enrollment.submitAccount(token, readText(payload.data, "account_number"));

      case "CHOOSE_DESTINATION":
        return this.enrollment.chooseDestination(token, readText(payload.data, "destination_id"));

      case "CODE":
        return this.enrollment.submitCode(token, readText(payload.data, "code"));

      case "SET_PIN":
        return this.enrollment.setPin(
          token,
          readText(payload.data, "pin"),
          readText(payload.data, "pin_confirmation"),
        );

      default:
        return undefined;
    }
  }

  /** A sealed answer, as the bare base64 body WhatsApp expects. */
  private seal(
    response: Response,
    payload: unknown,
    aesKey: Buffer,
    initialVector: Buffer,
  ): void {
    response
      .status(200)
      .type("text/plain")
      .send(encryptFlowResponse(payload, aesKey, initialVector));
  }

  /**
   * Refuses with a bare status and no body.
   *
   * The status code differs — Meta's protocol needs `421` to trigger a key
   * refresh — but nothing else does. **No body, and no reason**, because a
   * caller that can tell "wrong key" from "tampered" from "bad IV length" has
   * an oracle. The distinction is kept where the Bank can reach it: the
   * operational log and the audit table.
   */
  private async refuse(response: Response, reason: string, status: number): Promise<void> {
    this.logger.warn({ event: "flow_refused", status, reason });
    await this.audit.record({
      action: "flow.refused",
      actor: { kind: "system" },
      outcome: "refused",
      detail: { reason, status },
    });
    response.status(status).end();
  }
}

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
} from "@nestjs/common";

import type { Chose, Outbound, Said } from "@avni/platform-channels";

import { ConversationService } from "../conversation.service";
import type { OpenedInAppConversation, WaitingMessage } from "../middleware.client";
import { SERVED_CONTRACT_VERSIONS, widgetFor } from "./index";

/**
 * The second **Channel**: in-app chat inside the Bank's own mobile application.
 *
 * Three routes, all of them under a version the loader named, because the
 * loader-to-server contract is a public API in the strictest sense — it is
 * versioned, it is never broken, and it is the one interface on this map with
 * no deprecation path
 * ([ADR-0011](../../../../docs/adr/0011-the-snippet-is-a-loader-not-the-widget.md)).
 *
 * **What is different here from WhatsApp, and what is not.** Different: a
 * Customer arrives already authenticated by the Bank's application, so there is
 * no enrollment, no OTP and no Binding; a conversation is opened from a signed
 * envelope; and a reply comes back in the same HTTP response rather than going
 * out through the Graph API. Not different: everything between those two, which
 * is `ConversationService.answer` and is not told which Channel it is on.
 */

interface WidgetMessage {
  readonly conversationId?: unknown;
  readonly said?: unknown;
  readonly chose?: unknown;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller("widget/:version")
export class WidgetController {
  public constructor(
    @Inject(ConversationService) private readonly conversations: ConversationService,
  ) {}

  /**
   * The Widget itself, fetched at runtime by the four lines the Bank pasted.
   *
   * Served by the **Platform**, which is the prompt-injection surface — and
   * safe to serve from here precisely because everything it will ever collect
   * that is secret terminates at the Middleware instead
   * ([ADR-0007](../../../../docs/adr/0007-flow-confirmations-terminate-at-the-middleware.md)).
   */
  @Get("widget.js")
  @Header("content-type", "text/javascript; charset=utf-8")
  @Header("cache-control", "public, max-age=300")
  public widget(@Param("version") version: string): string {
    const source = widgetFor(version);
    // A version this server does not serve is a 404 rather than the newest one.
    // Quietly upgrading a handset to a contract it was not written against is
    // the failure mode versioning exists to prevent.
    if (!source) throw new NotFoundException(`No Widget is served for ${version}`);
    return source;
  }

  /**
   * Opens a conversation from the identity the Bank's backend signed.
   *
   * The envelope goes straight through to the Middleware. **Nothing in this
   * deployable reads it**, which is what keeps the signing secret — and the
   * account number inside the envelope — out of the layer a Customer's words
   * are read by ([ADR-0006](../../../../docs/adr/0006-secrets-and-security-records-live-outside-the-platform.md)).
   */
  @Post("conversations")
  @HttpCode(200)
  public async open(
    @Param("version") version: string,
    @Body() body: unknown,
  ): Promise<OpenedInAppConversation> {
    this.requireServedVersion(version);

    const identity = (body as { identity?: unknown } | null)?.identity;
    if (typeof identity !== "string" || identity.trim().length === 0) {
      throw new BadRequestException("a signed identity is required");
    }

    // An edited account number, an expired envelope and an unsigned one are one
    // answer. Which it was is in the Middleware's audit table and reaches
    // neither this layer nor the handset.
    return this.conversations.openInApp(identity);
  }

  /**
   * One turn of the conversation.
   *
   * `said` and `chose` stay distinct all the way in, exactly as they do on
   * WhatsApp. A Customer who *types* the text of a button reaches the model; a
   * Customer who *taps* it does not, and the difference is what stops an
   * injected instruction wearing the shape of a control we minted.
   */
  @Post("messages")
  @HttpCode(200)
  public async message(
    @Param("version") version: string,
    @Body() body: WidgetMessage,
  ): Promise<{ reply: Outbound | null }> {
    const conversationId = await this.drivable(version, body?.conversationId);

    // **`null` is a real answer.** A Support Officer owns this conversation, so
    // the Agent has left and there is nothing for it to say — the Officer's own
    // words arrive through the route below, written by a human and delivered by
    // the Middleware.
    const reply = await this.conversations.answer(
      conversationId,
      this.inboundFrom(body, conversationId),
    );
    return { reply: reply ?? null };
  }

  /**
   * What is waiting for this Customer, fetched when the panel opens and while it
   * is open.
   *
   * **This Channel has no window and needs no approved template** (ADR-0010). A
   * Support Officer answering at 9am does not have to reach a handset; the reply
   * is simply here when the Customer next opens the Bank's application, and
   * whether that also raises a push notification is the Bank's app's business.
   *
   * `after` is the last message id the panel has already drawn, so a reconnect
   * does not repeat the conversation back at the Customer.
   */
  @Get("messages")
  public async waiting(
    @Param("version") version: string,
    @Query("conversationId") conversationId?: string,
    @Query("after") after?: string,
  ): Promise<{ messages: readonly WaitingMessage[] }> {
    const id = await this.drivable(version, conversationId);
    return { messages: await this.conversations.waitingFor(id, after ?? "0") };
  }

  /**
   * The conversation this handset is allowed to drive, or a 404.
   *
   * **The Widget must not be able to name a WhatsApp conversation.** That
   * Channel resolves its account through a Binding, so a handset quoting one
   * would be reading whichever Customer holds it — and the answer comes from the
   * Middleware every time rather than from anything this deployable remembers.
   */
  private async drivable(version: string, conversationId: unknown): Promise<string> {
    this.requireServedVersion(version);

    if (typeof conversationId !== "string" || !UUID.test(conversationId)) {
      throw new NotFoundException("no such conversation");
    }
    if (!(await this.conversations.isInAppConversation(conversationId))) {
      throw new NotFoundException("no such conversation");
    }
    return conversationId;
  }

  /**
   * The normalised message shape, from what the Widget posted.
   *
   * `said` and `chose` stay distinct here exactly as they do coming off a
   * WhatsApp webhook — the split is the platform's injection boundary, and a
   * Channel that collapsed it would hand the model a string a Customer typed
   * while claiming they had tapped it.
   *
   * There is no correspondent to name on this Channel: the Bank's application
   * states who the Customer is on every session and we store nothing between
   * them, so the conversation is the only handle there is.
   */
  private inboundFrom(body: WidgetMessage, conversationId: string): Said | Chose {
    const common = {
      channel: "in_app_chat",
      channelIdentity: conversationId,
      externalId: conversationId,
    } as const;

    if (typeof body.said === "string" && body.said.trim().length > 0) {
      return { ...common, kind: "said", text: body.said };
    }
    if (typeof body.chose === "string" && body.chose.length > 0) {
      return { ...common, kind: "chose", id: body.chose };
    }

    throw new BadRequestException("a message must carry either said or chose");
  }

  private requireServedVersion(version: string): void {
    if (!SERVED_CONTRACT_VERSIONS.includes(version)) {
      throw new NotFoundException(`No Widget is served for ${version}`);
    }
  }
}

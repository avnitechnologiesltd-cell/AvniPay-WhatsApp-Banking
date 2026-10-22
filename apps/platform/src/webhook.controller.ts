import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  Inject,
  Logger,
  Post,
  Query,
} from "@nestjs/common";

import type { PlatformConfig } from "@avni/config";
import { readWebhook } from "@avni/platform-channels";

import { ConversationService } from "./conversation.service";
import { PLATFORM_CONFIG } from "./tokens";

/**
 * Where a Customer's words arrive.
 *
 * Two things this endpoint does deliberately:
 *
 * - **It answers 200 before doing the work.** Meta retries a webhook it did not
 *   get a 200 for, so a slow BankOne read would otherwise become the same
 *   message delivered several times.
 * - **It never lets a processing failure become a non-200**, for the same
 *   reason. What went wrong goes to the log, not to the retry queue.
 */
@Controller("channels/whatsapp")
export class WhatsAppWebhookController {
  private readonly logger = new Logger(WhatsAppWebhookController.name);

  public constructor(
    @Inject(PLATFORM_CONFIG) private readonly config: PlatformConfig,
    @Inject(ConversationService) private readonly conversations: ConversationService,
  ) {}

  /** Meta's subscription challenge. */
  @Get("webhook")
  @Header("content-type", "text/plain")
  public verify(
    @Query("hub.mode") mode: string,
    @Query("hub.verify_token") token: string,
    @Query("hub.challenge") challenge: string,
  ): string {
    if (mode !== "subscribe" || token !== this.config.whatsappVerifyToken) {
      throw new ForbiddenException();
    }
    return challenge ?? "";
  }

  @Post("webhook")
  @HttpCode(200)
  public receive(@Body() body: unknown): { received: true } {
    const inbound = readWebhook(body);

    for (const message of inbound) {
      void this.conversations.receive(message).catch((error: unknown) => {
        this.logger.error({
          event: "inbound_handling_failed",
          kind: message.kind,
          externalId: message.externalId,
          reason: error instanceof Error ? error.message : String(error),
        });
      });
    }

    return { received: true };
  }
}

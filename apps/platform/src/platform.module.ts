import { resolve } from "node:path";

import { Module, type DynamicModule } from "@nestjs/common";

import type { PlatformConfig } from "@avni/config";
import type { Pool } from "@avni/db";
import { ChannelsModule, WhatsAppMedia, WhatsAppSender } from "@avni/platform-channels";
import { OrchestrationModule, IntentResolver } from "@avni/platform-orchestration";
import { SupportAgent, SupportModule } from "@avni/platform-support";
import {
  DatabaseModule,
  HealthModule,
  S3ObjectStore,
  databaseReadinessCheck,
  versionOf,
  type ObjectWriter,
} from "@avni/service";

import { AttachmentCourier } from "./attachments";
import { ConversationService } from "./conversation.service";
import { MiddlewareClient } from "./middleware.client";
import {
  ATTACHMENT_WRITER,
  INTENT_RESOLVER,
  PLATFORM_CONFIG,
  SUPPORT_AGENT,
  WHATSAPP_MEDIA,
  WHATSAPP_SENDER,
} from "./tokens";
import { WhatsAppWebhookController } from "./webhook.controller";
import { WidgetController } from "./widget/widget.controller";

export {
  ATTACHMENT_WRITER,
  INTENT_RESOLVER,
  PLATFORM_CONFIG,
  SUPPORT_AGENT,
  WHATSAPP_MEDIA,
  WHATSAPP_SENDER,
} from "./tokens";

export const SERVICE_NAME = "platform";

/**
 * The Platform — channels, orchestration and support in one process, with the
 * boundaries between them enforced as package boundaries
 * ([ADR-0003](../../../docs/adr/0003-one-repo-three-deployables.md)).
 *
 * This is the only place all three are visible at once. It holds no banking
 * credential and no route to BankOne; it reaches the Middleware over HTTP like
 * anything else would.
 */
@Module({})
export class PlatformModule {
  public static forConfig(config: PlatformConfig, pool: Pool): DynamicModule {
    return {
      module: PlatformModule,
      imports: [
        DatabaseModule.forPool(pool),
        HealthModule.forService({
          service: SERVICE_NAME,
          version: versionOf(resolve(__dirname, "..")),
          environment: config.environment,
          checks: [databaseReadinessCheck(pool)],
        }),
        ChannelsModule.forPlatform(config),
        OrchestrationModule.forPlatform(config),
        SupportModule.forPlatform(config),
      ],
      controllers: [WhatsAppWebhookController, WidgetController],
      providers: [
        { provide: PLATFORM_CONFIG, useValue: config },
        {
          provide: INTENT_RESOLVER,
          useFactory: () =>
            new IntentResolver({
              baseUrl: config.groq.baseUrl,
              apiKey: config.groq.apiKey,
              model: config.groq.intentModel,
            }),
        },
        {
          // **A second model call, and a larger model.** Structured output and
          // tool use are mutually exclusive on Groq, so the Agent that reads the
          // Library and calls Connectors physically cannot emit a
          // schema-guaranteed Intent — which is exactly the split ADR-0001
          // already drew, now enforced by the provider rather than by policy.
          provide: SUPPORT_AGENT,
          useFactory: () =>
            new SupportAgent({
              baseUrl: config.groq.baseUrl,
              apiKey: config.groq.apiKey,
              model: config.groq.supportModel,
            }),
        },
        {
          provide: WHATSAPP_SENDER,
          useFactory: () =>
            new WhatsAppSender({
              graphApiBaseUrl: config.whatsapp.graphApiBaseUrl,
              apiToken: config.whatsapp.apiToken,
              phoneNumberId: config.whatsapp.phoneNumberId,
            }),
        },
        {
          // The two-hop fetch that turns a media id into bytes. It shares the
          // Graph credentials with the sender above because it is the same
          // WhatsApp account — and holds nothing else, because there is nothing
          // else it does.
          provide: WHATSAPP_MEDIA,
          useFactory: () =>
            new WhatsAppMedia({
              graphApiBaseUrl: config.whatsapp.graphApiBaseUrl,
              apiToken: config.whatsapp.apiToken,
            }),
        },
        {
          // **`ObjectWriter`, and the type is the point.** This deployable moves
          // a Customer's file into object storage without opening it, and the
          // interface it is handed has no `get` — so the injection surface
          // cannot read back what it stored, whatever the bucket policy says.
          provide: ATTACHMENT_WRITER,
          useFactory: (): ObjectWriter => new S3ObjectStore(config.attachments),
        },
        MiddlewareClient,
        AttachmentCourier,
        ConversationService,
      ],
      exports: [PLATFORM_CONFIG],
    };
  }
}

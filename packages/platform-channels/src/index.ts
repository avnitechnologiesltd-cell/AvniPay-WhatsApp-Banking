import { Module, type DynamicModule } from "@nestjs/common";

import type { PlatformConfig } from "@avni/config";

export type {
  Ask,
  Attachment,
  Channel,
  Chose,
  Inbound,
  InboundEvent,
  Outbound,
  Said,
  Say,
  Secure,
  Send,
} from "./message";
export { say } from "./message";
export { readWebhook, WhatsAppSender, type WhatsAppSenderOptions } from "./whatsapp";
export { WhatsAppMedia, type MediaFetch, type WhatsAppMediaOptions } from "./media";

export const CHANNELS_CONFIG = Symbol("CHANNELS_CONFIG");

/**
 * Channels — WhatsApp and in-app chat. Where a Customer's words arrive and
 * where the platform's replies go out.
 *
 * This module may not import orchestration or support, and neither may import
 * it. All three run in one process today ([ADR-0003](../../../docs/adr/0003-one-repo-three-deployables.md));
 * the option to split one out later is the entire justification for starting
 * merged, and it survives only while these boundaries hold.
 */
@Module({})
export class ChannelsModule {
  public static forPlatform(config: PlatformConfig): DynamicModule {
    return {
      module: ChannelsModule,
      providers: [{ provide: CHANNELS_CONFIG, useValue: config }],
      exports: [CHANNELS_CONFIG],
    };
  }
}

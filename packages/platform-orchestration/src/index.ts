import { Module, type DynamicModule } from "@nestjs/common";

import type { PlatformConfig } from "@avni/config";

export {
  IntentResolver,
  SYSTEM_PROMPT,
  type IntentResolverOptions,
  type Resolution,
} from "./resolver";

export const ORCHESTRATION_CONFIG = Symbol("ORCHESTRATION_CONFIG");

/**
 * The Orchestration Layer — turns what a Customer said into a structured
 * Intent. It may use an LLM, but only to resolve intent; it never executes a
 * banking operation and it holds no credential
 * ([ADR-0001](../../../docs/adr/0001-no-ai-in-the-banking-layer.md),
 * [ADR-0006](../../../docs/adr/0006-secrets-and-security-records-live-outside-the-platform.md)).
 *
 * This module may not import channels or support, and neither may import it.
 */
@Module({})
export class OrchestrationModule {
  public static forPlatform(config: PlatformConfig): DynamicModule {
    return {
      module: OrchestrationModule,
      providers: [{ provide: ORCHESTRATION_CONFIG, useValue: config }],
      exports: [ORCHESTRATION_CONFIG],
    };
  }
}

import { Module, type DynamicModule } from "@nestjs/common";

import type { PlatformConfig } from "@avni/config";

export {
  SUPPORT_SYSTEM_PROMPT,
  SupportAgent,
  type SupportAgentOptions,
  type SupportAnswer,
  type SupportMessage,
  type SupportTurn,
} from "./agent";
export {
  asksForASecret,
  claimsToBeAPerson,
  figuresIn,
  makesAnUncitedClaim,
  ungroundedFigures,
} from "./guards";
export {
  CONNECTOR_CALLS_PER_TURN,
  connectorFor,
  definitionFor,
  toolNameFor,
  type ConnectorCaller,
  type ConnectorParameter,
  type ConnectorParameterType,
  type ConnectorResult,
  type OfferedConnector,
} from "./connectors";
export {
  citationsFor,
  citationsInWords,
  type Citation,
  type LibrarySearch,
  type LibrarySection,
} from "./library";

export const SUPPORT_CONFIG = Symbol("SUPPORT_CONFIG");

/**
 * Support — the Support Agent and the Library it reads.
 *
 * Reads the Library as **text** and never as an **action**, which is the whole
 * of what separates a Library from a Connector: a Library has no side effect, so
 * it is never Gated and never takes a Transaction PIN, and the Bank authors it
 * while we store it. A Bank endpoint that returns policy text is a *Connector*
 * for the same reason — the model calls it.
 *
 * Handoff is not in here and is not this package's. It belongs to the Middleware,
 * because a Handoff transfers ownership of a conversation and the Platform must
 * not be able to decide it owns one
 * ([ADR-0012](../../../docs/adr/0012-a-handoff-transfers-ownership-and-the-model-stops-reading.md)).
 * What this package does is say *I cannot confirm that*; the application asks
 * for the human.
 *
 * This module may not import channels or orchestration, and neither may import
 * it.
 */
@Module({})
export class SupportModule {
  public static forPlatform(config: PlatformConfig): DynamicModule {
    return {
      module: SupportModule,
      providers: [{ provide: SUPPORT_CONFIG, useValue: config }],
      exports: [SUPPORT_CONFIG],
    };
  }
}

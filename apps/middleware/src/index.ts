import "reflect-metadata";

import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";

import type { MiddlewareConfig } from "@avni/config";
import { createPool, type Pool } from "@avni/db";
import { StdoutLogger, systemClock, type Clock } from "@avni/service";

import { PinnedHttpsDispatcher, type ConnectorDispatcher } from "./connectors/dispatcher";
import { MAX_UPLOAD_BYTES } from "./library/extraction";
import { MiddlewareModule, SERVICE_NAME } from "./middleware.module";
import { BankCodeMismatchError, checkOwnBankCode } from "./transfers/routing";

export { MIDDLEWARE_CONFIG, MiddlewareModule, SERVICE_NAME } from "./middleware.module";
export { BindingsRepository, type Binding } from "./identity/bindings.repository";
export { AuditRepository, type AuditQuery } from "./audit/audit.repository";
export { StaffRepository, type IssuedSession, type StaffAccount } from "./staff/staff.repository";
export { AuthenticationService, type Credentials } from "./staff/authentication";
export { generateTotpSecret, totp, totpEnrolmentUri, verifyTotp } from "./staff/totp";
export { CAPABILITIES, ROLES, can, isAdministratorOnly, requiresMfa, type Capability, type Role } from "./staff/roles";
export type {
  Actor,
  ActorKind,
  AuditAction,
  AuditEntry,
  AuditOutcome,
  AuditRecord,
} from "./audit/actions";
export type {
  IssuedSnippet,
  SnippetForVersion,
  SnippetView,
} from "./api/dashboard.controller";
export {
  ConversationsService,
  type Channel,
  type Conversation,
  type OpenedInAppConversation,
} from "./identity/conversations.service";
export {
  SnippetSecretsRepository,
  type IssuedSnippetSecret,
  type SnippetSecretRecord,
} from "./identity/snippet-secrets.repository";
export {
  CONTRACT_VERSIONS,
  CURRENT_CONTRACT_VERSION,
  signIdentityEnvelope,
  verifyIdentityEnvelope,
  type ContractVersion,
} from "./identity/signed-identity";
export { LOADER_UNAVAILABLE_MESSAGE, loaderScript, snippetFor } from "./identity/snippet";
export { TransactionPinService, type PinCheck } from "./pin/transaction-pin.service";
export {
  HANDOFF_TRIGGERS,
  HANDOFF_WORDS,
  PLATFORM_TRIGGERS,
  WHATSAPP_WINDOW_MS,
  pagesOperations,
  urgencyOf,
  waitsForBusinessHours,
  windowIsOpen,
  type HandoffTrigger,
  type PlatformTrigger,
} from "./support/handoff";
export {
  HandoffService,
  type ClaimOutcome,
  type ConversationForOfficer,
  type ConversationOwner,
  type Delivery,
  type HandoffRaised,
  type InboxEntry,
} from "./support/handoff.service";
export {
  MessagesRepository,
  type ConversationMessage,
  type MessageAttachment,
} from "./support/messages.repository";
export {
  SETTING_KEYS,
  SettingsRepository,
  type PlatformSettings,
  type SettingKey,
} from "./settings/settings.repository";
export {
  WEEKDAYS,
  businessHoursSchema,
  hoursInWords,
  isOpenAt,
  type BusinessHours,
  type Weekday,
} from "./settings/business-hours";
export {
  NO_TARIFF,
  chargeFor,
  feeInWords,
  tariffSchema,
  type Charge,
  type Tariff,
  type TariffBand,
} from "./settings/tariff";
export { BankOneAdapter, type AccountBalance, type ReadOutcome } from "./bankone/adapter";
export {
  LIBRARY_MEDIA_TYPES,
  MAX_UPLOAD_BYTES,
  isLibraryMediaType,
  type LibraryMediaType,
} from "./library/extraction";
export {
  LibraryRepository,
  type LibraryDocument,
  type LibraryVersion,
  type LibraryVersionStatus,
  type RetrievedSection,
} from "./library/library.repository";
export {
  DEFAULT_RETRIEVAL_BUDGET_TOKENS,
  LibraryService,
  type UploadOutcome,
  type UploadRequest,
} from "./library/library.service";
export { estimateTokens, sectionsIn, type Section } from "./library/sections";
export {
  ConnectorsRepository,
  type Connector,
  type ConnectorChanges,
  type ConnectorStatus,
  type NewConnector,
} from "./connectors/connectors.repository";
export {
  CONNECTOR_WORDS,
  CROWDED_CONNECTOR_COUNT,
  ConnectorsService,
  type ConnectorCallOutcome,
  type OfferedConnector,
  type RegistrationOutcome,
} from "./connectors/connectors.service";
export {
  DEFAULT_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  PinnedHttpsDispatcher,
  redirectProblem,
  type ConnectorCall,
  type ConnectorDispatcher,
  type DispatchOutcome,
} from "./connectors/dispatcher";
export { addressProblem, endpointProblem, kindOfAddress, type AddressKind } from "./connectors/egress";
export {
  MAX_PARAMETERS,
  MAX_STRING_LENGTH,
  PARAMETER_TYPES,
  checkArguments,
  declarationProblem,
  type ConnectorParameter,
  type ParameterType,
} from "./connectors/parameters";

export interface MiddlewareApplication {
  readonly app: INestApplication;
  readonly pool: Pool;
  readonly logger: StdoutLogger;
}

/**
 * Builds the Middleware from a configuration object rather than from the
 * environment, so a test can boot it beside the Platform with every external
 * base URL pointed at an arbitrary address and no production seam added for it.
 *
 * The `clock` is the one exception, and it is a deliberate one. A 1-hour
 * lockout, a 10-minute code and a 90-day dormancy window are behaviour rather
 * than timing details; a suite that cannot move time either sleeps for an hour
 * or asserts nothing at all, and it is always the second.
 */
export const createMiddlewareApplication = async (
  config: MiddlewareConfig,
  clock: Clock = systemClock,
  /**
   * How a Connector is called. The second deliberate seam, and the same kind of
   * one: a Connector endpoint is on the public internet by policy, so a fake
   * Bank API on loopback is unreachable by construction and a test stands
   * something in for the network rather than weakening the egress rule.
   */
  dispatcher?: ConnectorDispatcher,
): Promise<MiddlewareApplication> => {
  const logger = new StdoutLogger({ service: SERVICE_NAME, level: config.logLevel });

  // **Before anything is built, let alone served.** `BANK_CODE` decides which
  // institution every same-bank name enquiry is addressed to and whether a
  // transfer is intra- or inter-bank, and both of those are silent when it is
  // wrong. A code that belongs to a different bank stops the deployment here,
  // the same way a database that has not been migrated does.
  const ours = { code: config.bankOne.bankCode, name: config.bankName };
  const check = checkOwnBankCode(ours);
  if (check.outcome === "mismatch") throw new BankCodeMismatchError(ours, check.listedAs);
  if (check.outcome === "unlisted") {
    // Not a refusal. A list can lag a licence, and this is the only signal that
    // the code is unchecked rather than checked and agreed.
    logger.warn(
      { event: "bank_code_unlisted", bankCode: ours.code, bankName: ours.name },
      "Bootstrap",
    );
  } else {
    logger.log({ event: "bank_code_agrees", listedAs: check.listedAs }, "Bootstrap");
  }

  const pool = createPool(config.databaseUrl);
  const app = await NestFactory.create<NestExpressApplication>(
    MiddlewareModule.forConfig(config, pool, clock, dispatcher ?? new PinnedHttpsDispatcher()),
    {
      logger,
      // The Flows endpoint verifies X-Hub-Signature-256 over the exact bytes
      // Meta sent. Re-serialising the parsed body changes key order and
      // whitespace, and the signature then fails for reasons that look like a
      // Meta outage.
      rawBody: true,
      // **Registered by hand below**, because Nest's default json parser refuses
      // a body over 100KB and a one-page policy PDF already exceeds it. Left on,
      // its parser runs first and answers 413 before the wider one is reached.
      bodyParser: false,
      // Reject rather than `process.abort()`. Nest's default kills the process
      // with a core dump and a native stack trace; `runEntryPoint` instead
      // prints the one line an operator can act on — which for a mounted key
      // file is usually "wrong passphrase" or "not mounted".
      abortOnError: false,
    },
  );

  // **An Administrator's Library upload is the largest thing this deployable
  // ever accepts**, and it is the only reason these two lines exist.
  //
  // Sized at what the Library itself will take plus the third that base64 adds,
  // rather than removed — a limit is the only thing standing between an
  // authenticated typo and the heap. It is *global* because Express's parser is,
  // and that cost is written down here rather than discovered by whoever next
  // reads a request log. `rawBody` survives: Nest carries it from the options
  // above into whichever parser is registered, which is what keeps the Flows
  // signature check verifying the exact bytes Meta sent.
  app.useBodyParser("json", { limit: Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) });
  app.useBodyParser("urlencoded", { extended: true });

  return { app, pool, logger };
};

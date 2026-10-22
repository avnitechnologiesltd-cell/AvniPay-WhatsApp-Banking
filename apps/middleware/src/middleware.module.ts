import { resolve } from "node:path";

import { Module, type DynamicModule } from "@nestjs/common";

import type { MiddlewareConfig } from "@avni/config";
import type { Pool } from "@avni/db";
import {
  CLOCK,
  DatabaseModule,
  HealthModule,
  S3ObjectStore,
  databaseReadinessCheck,
  systemClock,
  versionOf,
  type Clock,
  type ObjectReader,
  type ObjectStore,
} from "@avni/service";

import { DashboardController } from "./api/dashboard.controller";
import { PlatformController } from "./api/platform.controller";
import { AuditRepository } from "./audit/audit.repository";
import { BankingService } from "./banking/banking.service";
import { ConnectorsRepository } from "./connectors/connectors.repository";
import { ConnectorsService } from "./connectors/connectors.service";
import { PinnedHttpsDispatcher, type ConnectorDispatcher } from "./connectors/dispatcher";
import { BankOneAdapter } from "./bankone/adapter";
import { BeneficiariesRepository } from "./beneficiaries/beneficiaries.repository";
import { CustomersService } from "./customers/customers.service";
import { BankIdentityClient } from "./enrollment/bank-identity.client";
import { EnrollmentRepository } from "./enrollment/enrollment.repository";
import { EnrollmentService } from "./enrollment/enrollment.service";
import { BindingsRepository } from "./identity/bindings.repository";
import { ConversationsService } from "./identity/conversations.service";
import { SnippetSecretsRepository } from "./identity/snippet-secrets.repository";
import { LibraryRepository } from "./library/library.repository";
import { LibraryService } from "./library/library.service";
import { FlowsController } from "./flows/flows.controller";
import { WidgetSurfaceController } from "./surfaces/widget.controller";
import { NotificationsService } from "./notifications/notifications.service";
import { TransactionPinService } from "./pin/transaction-pin.service";
import { MandatesRepository } from "./transfers/mandates.repository";
import { TransfersService } from "./transfers/transfers.service";
import { WalksRepository } from "./transfers/walks.repository";
import { AuthenticationService } from "./staff/authentication";
import { StaffRepository } from "./staff/staff.repository";
import { loadFlowsPrivateKey } from "./flows/key";
import { SettingsRepository } from "./settings/settings.repository";
import { AttachmentsService } from "./support/attachments";
import { HandoffService } from "./support/handoff.service";
import { HandoffsRepository } from "./support/handoffs.repository";
import { MessagesRepository } from "./support/messages.repository";
import {
  ATTACHMENT_READER,
  BANKONE_ADAPTER,
  BANK_IDENTITY_CLIENT,
  CONNECTOR_DISPATCHER,
  FLOWS_PRIVATE_KEY,
  LIBRARY_STORE,
  MIDDLEWARE_CONFIG,
} from "./tokens";

export {
  ATTACHMENT_READER,
  BANKONE_ADAPTER,
  BANK_IDENTITY_CLIENT,
  CONNECTOR_DISPATCHER,
  FLOWS_PRIVATE_KEY,
  LIBRARY_STORE,
  MIDDLEWARE_CONFIG,
} from "./tokens";

export const SERVICE_NAME = "middleware";

/**
 * The Middleware — the only component permitted to speak to BankOne, and the
 * only one that holds a credential or a security record
 * ([ADR-0002](../../../docs/adr/0002-middleware-is-the-sole-path-to-bankone.md),
 * [ADR-0006](../../../docs/adr/0006-secrets-and-security-records-live-outside-the-platform.md)).
 *
 * It reads no Customer text, which is precisely why the secrets live here.
 */
@Module({})
export class MiddlewareModule {
  public static forConfig(
    config: MiddlewareConfig,
    pool: Pool,
    clock: Clock = systemClock,
    /**
     * How a Connector is actually called, injected for the same reason the
     * clock is and no other. A Connector endpoint is on the public internet
     * **by policy** — the dispatcher refuses loopback, private and link-local
     * addresses on the resolved address at connect time — so a test's fake Bank
     * API is unreachable by construction. The tests stand something in for the
     * network rather than weakening that rule to let one through, and the
     * default here is the real thing.
     */
    dispatcher: ConnectorDispatcher = new PinnedHttpsDispatcher(),
  ): DynamicModule {
    return {
      module: MiddlewareModule,
      imports: [
        DatabaseModule.forPool(pool),
        HealthModule.forService({
          service: SERVICE_NAME,
          version: versionOf(resolve(__dirname, "..")),
          environment: config.environment,
          checks: [databaseReadinessCheck(pool)],
        }),
      ],
      controllers: [
        PlatformController,
        DashboardController,
        FlowsController,
        WidgetSurfaceController,
      ],
      providers: [
        { provide: MIDDLEWARE_CONFIG, useValue: config },
        { provide: CLOCK, useValue: clock },
        {
          provide: BANKONE_ADAPTER,
          useFactory: () => new BankOneAdapter({ config: config.bankOne }),
        },
        {
          provide: BANK_IDENTITY_CLIENT,
          useFactory: () =>
            new BankIdentityClient({
              baseUrl: config.bankIdentity.baseUrl,
              apiKey: config.bankIdentity.apiKey,
            }),
        },
        {
          // Read once at boot from its mounted path. A key that only fails to
          // load on the first Customer authorisation fails at the worst moment.
          provide: FLOWS_PRIVATE_KEY,
          useFactory: () => loadFlowsPrivateKey(config.whatsapp),
        },
        {
          // **`ObjectReader`, and the type is the point.** The Middleware serves
          // a Customer's file to a signed-in Officer and writes nothing; the
          // Platform holds the other half of the pair and cannot read.
          provide: ATTACHMENT_READER,
          useFactory: (): ObjectReader => new S3ObjectStore(config.attachments),
        },
        {
          // **The Library's half, and the one place the Middleware writes.** An
          // Administrator's policy document is bytes the platform reads on
          // purpose, so ingesting one needs a `put` that serving an attachment
          // never did. Same bucket, disjoint prefixes: `conversations/` is the
          // Platform's to write and this deployable's to read, `library/` is
          // this deployable's alone.
          provide: LIBRARY_STORE,
          useFactory: (): ObjectStore => new S3ObjectStore(config.attachments),
        },
        // The network, as the one thing that calls an address somebody typed
        // into a form. See the token, and `dispatcher.ts` for the five rules it
        // holds at connect time rather than at registration.
        { provide: CONNECTOR_DISPATCHER, useValue: dispatcher },
        AuditRepository,
        StaffRepository,
        AuthenticationService,
        BindingsRepository,
        SnippetSecretsRepository,
        ConversationsService,
        BankingService,
        EnrollmentRepository,
        EnrollmentService,
        NotificationsService,
        TransactionPinService,
        MandatesRepository,
        WalksRepository,
        BeneficiariesRepository,
        CustomersService,
        TransfersService,
        SettingsRepository,
        MessagesRepository,
        HandoffsRepository,
        HandoffService,
        AttachmentsService,
        LibraryRepository,
        LibraryService,
        ConnectorsRepository,
        ConnectorsService,
      ],
      exports: [
        MIDDLEWARE_CONFIG,
        CLOCK,
        AuditRepository,
        StaffRepository,
        AuthenticationService,
        BindingsRepository,
        SnippetSecretsRepository,
        ConversationsService,
        EnrollmentService,
        TransactionPinService,
        TransfersService,
        SettingsRepository,
        MessagesRepository,
        HandoffsRepository,
        HandoffService,
        CustomersService,
        LibraryRepository,
        LibraryService,
        ConnectorsService,
      ],
    };
  }
}

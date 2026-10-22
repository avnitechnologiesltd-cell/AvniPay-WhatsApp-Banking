import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Inject,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";

import type { MiddlewareConfig } from "@avni/config";
import { TRANSACTION_PERIODS, type TransactionPeriod } from "@avni/intent";

import { AuditRepository } from "../audit/audit.repository";
import type { Actor, AuditEntry, AuditOutcome } from "../audit/actions";
import type { Connector } from "../connectors/connectors.repository";
import { CROWDED_CONNECTOR_COUNT, ConnectorsService } from "../connectors/connectors.service";
import { PARAMETER_TYPES } from "../connectors/parameters";
import {
  CustomersService,
  type BeneficiaryView,
  type CustomerSearchResult,
  type CustomerTransactions,
  type CustomerView,
} from "../customers/customers.service";
import { readCustomerQuery } from "../customers/query";
import {
  CONTRACT_VERSIONS,
  CURRENT_CONTRACT_VERSION,
  type ContractVersion,
} from "../identity/signed-identity";
import { signingInstructions, snippetFor } from "../identity/snippet";
import {
  SnippetSecretsRepository,
  type SnippetSecretRecord,
} from "../identity/snippet-secrets.repository";
import { MAX_UPLOAD_BYTES } from "../library/extraction";
import type { LibraryDocument, LibraryVersion } from "../library/library.repository";
import { LibraryService } from "../library/library.service";
import type { Section } from "../library/sections";
import {
  SETTING_KEYS,
  SettingsRepository,
  type PlatformSettings,
  type SettingKey,
} from "../settings/settings.repository";
import type { Tariff } from "../settings/tariff";
import { AttachmentsService } from "../support/attachments";
import {
  HandoffService,
  type ConversationForOfficer,
  type Delivery,
  type InboxEntry,
} from "../support/handoff.service";
import { MIDDLEWARE_CONFIG } from "../tokens";
import { AuthenticationService } from "../staff/authentication";
import { ROLES } from "../staff/roles";
import { can, type Capability, type Role } from "../staff/roles";
import { passwordProblem } from "../staff/passwords";
import { StaffRepository } from "../staff/staff.repository";
import type { LiveSession, StaffAccount } from "../staff/staff.repository";

/**
 * The Middleware's Dashboard-facing surface.
 *
 * Separate from `/platform` on purpose. The two callers are not the same
 * caller: the Platform reads a Customer's words and must reach almost nothing,
 * while the Dashboard is where the Bank's staff look at everything. Keeping
 * them different routes is what let the authentication boundary land on one
 * without touching the other.
 *
 * **Every action here writes an audit row, reads included.** Deciding per
 * screen what counts as sensitive is a judgement that rots as screens are
 * added, and it fails in the direction of forgetting. Two surfaces make
 * *looking* the sensitive act — the Beneficiary view exposes who a Customer
 * pays, and transaction history exposes everything they have ever done with
 * their money — and neither can be audited retroactively.
 */

const signInBody = z.object({
  email: z.string().trim().min(1),
  password: z.string().min(1),
  totpCode: z.string().trim().optional(),
});

const createOfficerBody = z.object({
  email: z.string().trim().min(3).includes("@"),
  displayName: z.string().trim().min(1),
  password: z.string(),
  role: z.enum(ROLES),
});

/**
 * What an Administrator may change about somebody else's account.
 *
 * **No email.** An account's address is what signs it in and what every audit
 * row it appears in was written against; changing it would silently re-point a
 * history. Somebody who needs a different address needs a different account.
 *
 * Every field is optional and an absent one means *leave it*, which is what lets
 * the display-name form and the access controls be separate forms on the screen
 * without either clobbering the other's field.
 */
const updateOfficerBody = z
  .object({
    displayName: z.string().trim().min(1).max(60).optional(),
    role: z.enum(ROLES).optional(),
    disabled: z.boolean().optional(),
  })
  .refine(
    (changes) => Object.values(changes).some((value) => value !== undefined),
    "nothing was asked to change",
  );

const passwordBody = z.object({ password: z.string() });

/** Enrolling a second factor. The password is the whole of the check — see the service. */
const mfaEnrolmentBody = z.object({
  email: z.string().trim().min(1),
  password: z.string().min(1),
});

const mfaConfirmationBody = mfaEnrolmentBody.extend({
  totpCode: z.string().trim().min(1),
});

const BEARER = /^Bearer (.+)$/i;

/**
 * A NUBAN is ten digits, and this is checked **after** the audit row is
 * written.
 *
 * The order is the point: an Officer who put something else in the path is
 * recorded as having tried, and only then refused. A validation that ran first
 * would leave the one class of request most worth seeing — a Dashboard session
 * probing the Middleware with something that is not an account number — with no
 * row at all.
 */
const TEN_DIGITS = /^\d{10}$/;

const requireAccountNumber = (accountNumber: string): void => {
  if (!TEN_DIGITS.test(accountNumber)) {
    throw new BadRequestException("An account number is ten digits.");
  }
};

/**
 * What the history screen shows before an Officer chooses.
 *
 * A month rather than today: an Officer opens this because a Customer is asking
 * about something that has already happened, and *"nothing today"* is almost
 * never the answer they were after.
 */
const DEFAULT_PERIOD: TransactionPeriod = "last_month";

/**
 * Every action this controller can take, as one closed list.
 *
 * Named here rather than passed as free strings so a new surface cannot be
 * added without also deciding what it records — which is how "every action
 * writes a row" stays true as screens are added.
 */
type DashboardAction =
  | "audit.read"
  | "customer.searched"
  | "customer.read"
  | "customer.transactions_read"
  | "customer.beneficiaries_read"
  // Written by `BindingsRepository` on the way through, so this controller
  // names it only to record a **refusal** — which never reaches the repository.
  | "binding.revoked"
  | "staff.me_read"
  | "officers.read"
  | "officers.write"
  | "snippet.issued"
  | "snippet.read"
  | "snippet.secret_revoked"
  | "inbox.read"
  | "handoff.claimed"
  | "handoff.replied"
  | "handoff.resolved"
  | "attachment.read"
  | "settings.read"
  | "settings.write"
  | "tariff.read"
  | "tariff.write"
  | "officers.password_reset"
  | "staff.sessions_revoked"
  | "library.read"
  // The three writes are recorded by `LibraryService`, which knows what the act
  // did as well as that it happened. Named here so a **refusal** — which never
  // reaches the service — is still a row.
  | "library.uploaded"
  | "library.published"
  | "library.withdrawn"
  | "library.discarded"
  | "connector.read"
  // The three writes are recorded by `ConnectorsService`, which knows what the
  // act did as well as that it happened. Named here so a **refusal** — which
  // never reaches the service — is still a row.
  | "connector.registered"
  | "connector.changed"
  | "connector.retired";

/**
 * A document an Administrator is putting into the Library.
 *
 * **The bytes arrive base64 in JSON rather than as multipart**, which is worth
 * a sentence: every other call the Dashboard makes is JSON with a bearer token,
 * and one multipart route would be a second request shape, a second parser and a
 * second set of limits to get right for a screen a handful of people use a
 * handful of times a year.
 *
 * `versionDate` is the **Bank's own date for the policy**, typed by the person
 * uploading it, and deliberately not the upload timestamp. A citation names it,
 * and *"the day somebody dragged the file in"* is not a fact about the Bank's
 * policy.
 */
const libraryUploadBody = z.object({
  title: z.string().trim().min(1).max(200),
  /** Present when this is a new version of a document that already exists. */
  documentId: z.string().uuid().optional(),
  versionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be a date, as YYYY-MM-DD"),
  mediaType: z.string().trim().min(1).max(255),
  fileName: z.string().trim().max(255).default(""),
  // Sized in base64 characters, which is what actually arrived. The Library
  // checks the decoded length too — this is the cheap refusal before the
  // expensive one.
  content: z
    .string()
    .min(1)
    .max(Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 4, "that file is too large for the Library"),
});

/** The Administrator's own sentence about what was wrong with their upload. */
const problemIn = (error: z.ZodError): string =>
  error.issues
    .map((issue) => [issue.path.join("."), issue.message].filter(Boolean).join(" "))
    .join("; ");

/**
 * The registration form, and **the whole contract is these six fields**.
 *
 * There is no method field: the Middleware always sends `POST` with a JSON
 * body, so the only thing the Bank describes is what the fields inside it are
 * called. Imposing the envelope costs a third party's API a thin shim and costs
 * the Bank's own APIs nothing, and it leaves something on our side to validate
 * against rather than pushing every malformed call through to their endpoint.
 *
 * The credential is a value that arrives once. Nothing here reads one back, and
 * the shape below is the only place in the platform where one is a string.
 */
const parameterBody = z.object({
  name: z.string().trim().min(1).max(40),
  type: z.enum(PARAMETER_TYPES),
  required: z.boolean().default(false),
  description: z.string().trim().max(200).default(""),
});

const connectorBody = z.object({
  name: z.string().trim().min(2).max(40),
  description: z.string().trim().min(1).max(500),
  endpoint: z.string().trim().min(1).max(2_000),
  // **Defaulted on**, so leaving Gated off is a deliberate act rather than an
  // oversight — the same default the withdrawn Verify User checkbox carried,
  // and for the same reason: the platform cannot know that an opaque URL
  // changes a phone number.
  gated: z.boolean().default(true),
  parameters: z.array(parameterBody).default([]),
  credentialHeader: z.string().trim().min(1).max(64).default("authorization"),
  credential: z.string().min(1).max(4_000),
});

/**
 * What may be changed afterwards. **No name**: it is what the Support Agent
 * calls and what every audit row about a dispatch through it names, so changing
 * one would silently re-point a history.
 *
 * An absent `credential` keeps the stored one. There is no way to check what it
 * currently is, which is the point of it being write-only.
 */
const connectorChangesBody = z
  .object({
    description: z.string().trim().min(1).max(500).optional(),
    endpoint: z.string().trim().min(1).max(2_000).optional(),
    gated: z.boolean().optional(),
    parameters: z.array(parameterBody).optional(),
    credentialHeader: z.string().trim().min(1).max(64).optional(),
    credential: z.string().min(1).max(4_000).optional(),
  })
  .refine(
    (changes) => Object.values(changes).some((value) => value !== undefined),
    "nothing was asked to change",
  );

const replyBody = z.object({ body: z.string().trim().min(1).max(4_000) });

/**
 * One setting at a time, and the value is `unknown` here on purpose.
 *
 * What a valid business-hours object is belongs beside the code that acts on
 * it, not in a controller — `SettingsRepository.write` validates and answers
 * *why* it refused, and this passes the sentence through so an Administrator
 * fixing a typo is told which field.
 */
const settingBody = z.object({
  key: z.enum(SETTING_KEYS as [SettingKey, ...SettingKey[]]),
  value: z.unknown(),
});

/**
 * The tariff, in an envelope, and the envelope is load-bearing.
 *
 * `null` is a real value — it is how a Bank withdraws its tariff — so *absent*
 * and *null* must not be the same request. `z.unknown()` is optional in zod, so
 * the presence of the key is checked rather than assumed.
 */
const tariffBody = z
  .object({ tariff: z.unknown() })
  .refine((body) => "tariff" in body, "a tariff is required; null withdraws the current one");

const issueSnippetBody = z.object({
  /** What to call this secret, so the Bank can tell two apart in a rotation. */
  label: z.string().trim().max(60).optional(),
});

/**
 * What the Dashboard shows after generating a Snippet.
 *
 * The `secret` is present **exactly once, in this response**. Nothing reads it
 * back afterwards — not this controller, not the Administrator who generated
 * it. Changing a secret means issuing another one, which is the same rule
 * ticket 18 set for Connector credentials.
 */
export interface IssuedSnippet {
  readonly snippet: string;
  readonly secret: string;
  readonly secretId: string;
  readonly contractVersion: string;
  readonly signingInstructions: readonly string[];
}

/** One contract version's Snippet, as an Administrator copies it. */
export interface SnippetForVersion {
  readonly contractVersion: string;
  readonly snippet: string;
  readonly signingInstructions: readonly string[];
}

/** The Snippet as it can be read afterwards: everything except the secret. */
export interface SnippetView {
  /** What a Bank integrating today should paste. */
  readonly current: SnippetForVersion;
  /**
   * **Every version, not just the current one.** A Snippet inside a shipped
   * mobile application cannot be recalled, so once v2 exists there are still
   * handsets running v1 — and a Bank's engineer debugging one of them needs to
   * be able to read back the exact four lines they pasted.
   */
  readonly versions: readonly SnippetForVersion[];
  readonly secrets: readonly SnippetSecretRecord[];
}

@Controller("dashboard")
export class DashboardController {
  public constructor(
    @Inject(AuditRepository) private readonly audit: AuditRepository,
    @Inject(AuthenticationService) private readonly authentication: AuthenticationService,
    @Inject(StaffRepository) private readonly staff: StaffRepository,
    @Inject(SnippetSecretsRepository) private readonly snippets: SnippetSecretsRepository,
    @Inject(MIDDLEWARE_CONFIG) private readonly config: MiddlewareConfig,
    @Inject(HandoffService) private readonly handoff: HandoffService,
    @Inject(AttachmentsService) private readonly attachments: AttachmentsService,
    @Inject(SettingsRepository) private readonly settings: SettingsRepository,
    @Inject(CustomersService) private readonly customers: CustomersService,
    @Inject(LibraryService) private readonly library: LibraryService,
    @Inject(ConnectorsService) private readonly connectors: ConnectorsService,
  ) {}

  // --- The Inbox -------------------------------------------------------------

  /**
   * **One shared Inbox**, and every Officer sees the same list.
   *
   * Auto-assignment was rejected for v1: it needs presence tracking and staffing
   * rules that do not exist yet, and nothing here blocks adding it later. What a
   * shared list needs instead is an exclusive claim, which is the route below.
   */
  @Get("inbox")
  public async readInbox(
    @Headers("authorization") authorization?: string,
  ): Promise<{ conversations: readonly InboxEntry[] }> {
    await this.require(authorization, "inbox.work", "inbox.read");
    return { conversations: await this.handoff.inbox() };
  }

  /**
   * One conversation, with everything an Officer needs to answer it.
   *
   * The `said`/`chose`/`event` history rather than a flat transcript, the
   * Agent's summary, which trigger fired, the account number and the Channel.
   * An Officer who has to re-ask the Customer everything makes the Handoff worse
   * than no Agent, and this payload is the whole of the defence against that.
   */
  @Get("inbox/:handoffId")
  public async readConversation(
    @Param("handoffId") handoffId: string,
    @Headers("authorization") authorization?: string,
  ): Promise<ConversationForOfficer> {
    await this.require(authorization, "inbox.work", "inbox.read", { handoffId });

    const view = await this.handoff.view(handoffId);
    if (!view) throw new NotFoundException("No such conversation.");
    return view;
  }

  /**
   * Takes a conversation out of the Inbox. **Exclusive**, so two Officers
   * cannot answer at once.
   *
   * A refusal is a `409`, not a `403`: the Officer is allowed to claim
   * conversations and simply lost this one, and telling them *"your role does
   * not allow that"* would send them to an Administrator over a race.
   */
  @Post("inbox/:handoffId/claim")
  public async claim(
    @Param("handoffId") handoffId: string,
    @Headers("authorization") authorization?: string,
  ): Promise<InboxEntry> {
    const { account } = await this.requireQuietly(authorization, "inbox.work", "handoff.claimed", {
      handoffId,
    });

    const claimed = await this.handoff.claim(handoffId, account);
    switch (claimed.outcome) {
      case "claimed":
        return claimed.entry;
      case "taken":
        throw new ConflictException(`${claimed.by} is already answering this conversation.`);
      case "not_found":
        throw new NotFoundException("No such conversation.");
    }
  }

  /** The Officer's own words, delivered by the Middleware and never by the Platform. */
  @Post("inbox/:handoffId/reply")
  public async reply(
    @Param("handoffId") handoffId: string,
    @Body() body: unknown,
    @Headers("authorization") authorization?: string,
  ): Promise<{ delivery: Delivery }> {
    const parsed = replyBody.safeParse(body);
    const { account } = await this.requireQuietly(authorization, "inbox.work", "handoff.replied", {
      handoffId,
      // Never the words. They are in `conversation_messages`, which is where the
      // Bank reads what was said; the audit row records that it happened.
      rejected: parsed.success ? null : "empty",
    });
    if (!parsed.success) throw new BadRequestException("A reply cannot be empty.");

    return this.finishOfficerAct(await this.handoff.reply(handoffId, account, parsed.data.body));
  }

  /**
   * The Officer closes it, and the Agent takes the Customer's **next** message.
   *
   * There is no mid-conversation handback and no idle auto-return, so this is
   * the only way a conversation goes back — which is deliberate, and is why the
   * Customer is told by name at both ends.
   */
  @Post("inbox/:handoffId/resolve")
  public async resolve(
    @Param("handoffId") handoffId: string,
    @Headers("authorization") authorization?: string,
  ): Promise<{ delivery: Delivery }> {
    const { account } = await this.requireQuietly(authorization, "inbox.work", "handoff.resolved", {
      handoffId,
    });

    return this.finishOfficerAct(await this.handoff.resolve(handoffId, account));
  }

  /**
   * A file the Customer sent, served to the Officer reading the conversation.
   *
   * **The only reader there is.** The Platform wrote these bytes without opening
   * them and holds a credential that cannot read them back; the Orchestration
   * Layer was told a file exists and nothing else. The key is never taken from
   * the caller — an Officer names a message and the key comes out of the row.
   */
  @Get("inbox/:handoffId/attachments/:messageId")
  public async attachment(
    @Param("handoffId") handoffId: string,
    @Param("messageId") messageId: string,
    @Res() response: Response,
    @Headers("authorization") authorization?: string,
  ): Promise<void> {
    await this.require(authorization, "inbox.work", "attachment.read", { handoffId, messageId });

    const view = await this.handoff.view(handoffId);
    if (!view) throw new NotFoundException("No such conversation.");

    const file = await this.attachments.read(view.conversationId, messageId);
    if (file.outcome === "not_found") throw new NotFoundException("No such attachment.");
    if (file.outcome === "unavailable") {
      throw new ServiceUnavailableException("That file could not be read just now.");
    }

    response.setHeader("content-type", file.contentType);
    // **`attachment`, always.** The Customer chose the filename and the bytes,
    // and a document rendered inline in the Dashboard would be a Customer
    // choosing what a member of the Bank's staff loads in their browser.
    response.setHeader("content-disposition", "attachment");
    response.setHeader("x-content-type-options", "nosniff");
    response.end(Buffer.from(file.bytes));
  }

  // --- Customers ---------------------------------------------------------------

  /**
   * An Officer looks a Customer up.
   *
   * **The whole of this surface is held by both roles.** Ticket 22's table gives
   * a Support Officer everything on it — accounts, balances, history,
   * Beneficiaries and Binding revocation alike — and nothing here is
   * Administrator-only, because an Officer who has to fetch an Administrator to
   * answer *"where did my money go"* is an Officer who alt-tabs into BankOne
   * instead.
   *
   * The row is written **before** the search, and it carries what was typed.
   * *"Who went looking for this Customer"* is where an investigation starts, and
   * a query recorded only on success would omit precisely the probing attempts
   * worth finding.
   */
  @Get("customers")
  public async searchCustomers(
    @Query("q") q?: string,
    @Headers("authorization") authorization?: string,
  ): Promise<CustomerSearchResult> {
    const typed = (q ?? "").trim();
    const { account } = await this.require(
      authorization,
      "customers.read",
      "customer.searched",
      { query: typed },
      // **In the column, when what was typed is an account number.** A phone
      // number has no column to go in and stays in `detail`; an account number
      // does, and burying it in JSON would make *"who has looked at this
      // account"* a query the Bank cannot run against its own table.
      readCustomerQuery(typed).accountNumber,
    );

    return this.customers.search(typed, this.actorFor(account));
  }

  /**
   * One Customer: the account, its balances, and every Binding it has had.
   *
   * A view that **changes nothing** and writes a row anyway, which is the whole
   * point of this surface — reading a Customer's money is the sensitive act, and
   * it cannot be audited retroactively.
   */
  @Get("customers/:accountNumber")
  public async readCustomer(
    @Param("accountNumber") accountNumber: string,
    @Headers("authorization") authorization?: string,
  ): Promise<CustomerView> {
    const { account } = await this.require(
      authorization,
      "customers.read",
      "customer.read",
      {},
      accountNumber,
    );
    requireAccountNumber(accountNumber);

    return this.customers.view(accountNumber, this.actorFor(account));
  }

  /**
   * What has happened on the account.
   *
   * Answers `not_available` on the token the Bank actually has today —
   * `GetTransactions` is not entitled on the first deployment's tenancy and
   * `GetDailyAccountStatement` 404s on their deployment (Appendix A.1, ticket
   * 16). That is a **first-class outcome** rather than an error or an empty
   * list: an Officer shown a blank would tell a Customer nothing had happened on
   * their account.
   */
  @Get("customers/:accountNumber/transactions")
  public async readCustomerTransactions(
    @Param("accountNumber") accountNumber: string,
    @Query("period") period?: string,
    @Headers("authorization") authorization?: string,
  ): Promise<CustomerTransactions> {
    const chosen = TRANSACTION_PERIODS.find((known) => known === period) ?? DEFAULT_PERIOD;
    const { account } = await this.require(
      authorization,
      "customers.read",
      "customer.transactions_read",
      { period: chosen },
      accountNumber,
    );
    requireAccountNumber(accountNumber);

    return this.customers.transactions(accountNumber, chosen, this.actorFor(account));
  }

  /**
   * Who this Customer pays. **Read-only, and there is no write anywhere.**
   *
   * The most exposing read on the surface: it is a list of everybody a Customer
   * sends money to, under the names they chose themselves. Denying it makes the
   * commonest support call — *"I sent money to the wrong Musa"* — unanswerable;
   * granting it silently would hand every Officer that list with no record of
   * who looked. So it is granted and recorded, and it is `beneficiaries.read`
   * rather than `customers.read` so the Bank can tell the two apart in the table
   * without reading the action name.
   *
   * The **Support Agent still never reads this store** ([ADR-0008](../../../../docs/adr/0008-an-intent-becomes-a-mandate-when-authorised.md)).
   * Nothing about this route changes that: it is on `/dashboard`, behind a staff
   * session, and the Platform has no route to it at all.
   */
  @Get("customers/:accountNumber/beneficiaries")
  public async readCustomerBeneficiaries(
    @Param("accountNumber") accountNumber: string,
    @Headers("authorization") authorization?: string,
  ): Promise<{ beneficiaries: readonly BeneficiaryView[] }> {
    await this.require(
      authorization,
      "beneficiaries.read",
      "customer.beneficiaries_read",
      {},
      accountNumber,
    );
    requireAccountNumber(accountNumber);

    return { beneficiaries: await this.customers.beneficiariesOf(accountNumber) };
  }

  /**
   * **The one write on this surface**, and it is a security event.
   *
   * The Customer's access over that channel stops on the next message: every
   * turn asks the Middleware which account the conversation reaches, and a
   * revoked Binding reaches none. Their Beneficiaries are untouched, because the
   * store is keyed on the account rather than on the Binding.
   *
   * `requireQuietly`, for the same reason the Inbox uses it: the act itself is
   * recorded by `BindingsRepository` as `binding.revoked` with this Officer as
   * the actor, and a second row from here would be one event under one name
   * twice. A **refusal** still has to be written here, because a refused act
   * never reaches the repository at all.
   */
  @Post("customers/:accountNumber/bindings/:bindingId/revoke")
  public async revokeBinding(
    @Param("accountNumber") accountNumber: string,
    @Param("bindingId") bindingId: string,
    @Headers("authorization") authorization?: string,
  ): Promise<{ revoked: true }> {
    const { account } = await this.requireQuietly(
      authorization,
      "binding.revoke",
      "binding.revoked",
      { bindingId },
      accountNumber,
    );
    requireAccountNumber(accountNumber);

    const result = await this.customers.revokeBinding(
      accountNumber,
      bindingId,
      this.actorFor(account),
    );

    switch (result.outcome) {
      case "revoked":
        return { revoked: true };
      case "already_revoked":
        // Not an error. The Binding is gone, which is what was asked for, and a
        // `409` here would send an Officer to look for a problem that is not one.
        return { revoked: true };
      case "not_found":
        // Also the answer for a Binding belonging to a **different** account. An
        // Officer who mistyped an account number learns nothing about whose
        // Binding they nearly reached.
        throw new NotFoundException("No such Binding on this account.");
    }
  }

  // --- The Library -------------------------------------------------------------

  /**
   * Every document and every version of each, with the live one marked.
   *
   * **Readable by a Support Officer**, because an Officer who has just been
   * handed a conversation needs to be able to check what the Agent was allowed
   * to say. Writable only by an Administrator, for the same reason Connector
   * registration is: Library text is model-facing text the Bank writes.
   */
  @Get("library")
  public async readLibrary(
    @Headers("authorization") authorization?: string,
  ): Promise<{ documents: readonly LibraryDocument[] }> {
    await this.require(authorization, "library.read", "library.read");
    return { documents: await this.library.documents() };
  }

  /**
   * One version, **with its extracted text**.
   *
   * This is the screen the whole ingestion design exists for. PDF extraction
   * fails silently — a two-column policy comes out as every line of the left
   * column glued to the line beside it — and nothing in the platform can tell
   * that from a document that read perfectly. A person can, at a glance, and
   * this is where they do it.
   */
  @Get("library/versions/:versionId")
  public async readLibraryVersion(
    @Param("versionId") versionId: string,
    @Headers("authorization") authorization?: string,
  ): Promise<{ version: LibraryVersion; sections: readonly Section[] }> {
    await this.require(authorization, "library.read", "library.read", { versionId });

    const version = await this.library.version(versionId);
    if (!version) throw new NotFoundException("No such Library version.");

    return { version, sections: await this.library.sectionsOf(versionId) };
  }

  /**
   * Uploads a document. **It arrives as a draft and a draft is never
   * retrievable** — publishing is the separate call below.
   */
  @Post("library")
  public async uploadToLibrary(
    @Body() body: unknown,
    @Headers("authorization") authorization?: string,
  ): Promise<{ documentId: string; versionId: string }> {
    const parsed = libraryUploadBody.safeParse(body);
    const { account } = await this.requireQuietly(authorization, "library.write", "library.uploaded", {
      rejected: parsed.success ? null : problemIn(parsed.error),
    });

    if (!parsed.success) throw new BadRequestException(problemIn(parsed.error));

    const uploaded = await this.library.upload(
      {
        title: parsed.data.title,
        ...(parsed.data.documentId ? { documentId: parsed.data.documentId } : {}),
        versionDate: parsed.data.versionDate,
        mediaType: parsed.data.mediaType,
        fileName: parsed.data.fileName,
        // `base64` decoding never throws — it discards what it cannot read — so
        // a body that is not base64 at all arrives here as a short buffer and is
        // refused by the extractor, which is the layer that knows what a
        // readable document looks like.
        bytes: new Uint8Array(Buffer.from(parsed.data.content, "base64")),
      },
      this.actorFor(account),
    );

    if (uploaded.outcome === "refused") throw new BadRequestException(uploaded.problem);
    return { documentId: uploaded.documentId, versionId: uploaded.versionId };
  }

  /**
   * **The separate, explicit step.** From this moment the Support Agent may
   * quote it to a Customer, and whatever version was live no longer exists as a
   * live thing.
   */
  @Post("library/versions/:versionId/publish")
  public async publishLibraryVersion(
    @Param("versionId") versionId: string,
    @Headers("authorization") authorization?: string,
  ): Promise<{ version: LibraryVersion }> {
    const { account } = await this.requireQuietly(
      authorization,
      "library.write",
      "library.published",
      { versionId },
    );

    const published = await this.library.publish(versionId, this.actorFor(account));
    if (published.outcome === "refused") throw new BadRequestException(published.problem);
    return { version: published.version };
  }

  /**
   * Takes a live version out of reach, **in the very next turn**.
   *
   * There is no index to rebuild and no cache to clear, because the sections the
   * Dashboard wrote are the same rows retrieval reads. That is the whole reason
   * this design refuses a second copy of the text anywhere: every extra copy is
   * a place a withdrawn policy survives, and a Support Agent quoting a withdrawn
   * policy is a compliance problem for the Bank.
   */
  @Post("library/versions/:versionId/withdraw")
  public async withdrawLibraryVersion(
    @Param("versionId") versionId: string,
    @Headers("authorization") authorization?: string,
  ): Promise<{ version: LibraryVersion }> {
    const { account } = await this.requireQuietly(
      authorization,
      "library.write",
      "library.withdrawn",
      { versionId },
    );

    const withdrawn = await this.library.withdraw(versionId, this.actorFor(account));
    if (withdrawn.outcome === "refused") throw new BadRequestException(withdrawn.problem);
    return { version: withdrawn.version };
  }

  /**
   * Throws away a draft nobody published — and **only** a draft.
   *
   * A published version is the Bank's record of what a Customer may have been
   * told, and evidence is not something this platform deletes. A draft was never
   * retrievable, so there is nothing to reconstruct.
   */
  @Post("library/versions/:versionId/discard")
  public async discardLibraryDraft(
    @Param("versionId") versionId: string,
    @Headers("authorization") authorization?: string,
  ): Promise<{ discarded: true }> {
    const { account } = await this.requireQuietly(
      authorization,
      "library.write",
      "library.discarded",
      { versionId },
    );

    const discarded = await this.library.discard(versionId, this.actorFor(account));
    if (discarded.outcome === "refused") throw new BadRequestException(discarded.problem);
    return { discarded: true };
  }

  // --- Connectors ---------------------------------------------------------------

  /**
   * Every Connector the Bank has registered, and **no credential**.
   *
   * Readable by a Support Officer, who needs to know what the Agent could have
   * done in a conversation they have just been handed. Writable by an
   * Administrator alone: registering a Connector grants the Support Agent a
   * capability, and with Gated it registers something a Customer's Transaction
   * PIN will authorise.
   */
  @Get("connectors")
  public async readConnectors(
    @Headers("authorization") authorization?: string,
  ): Promise<{ connectors: readonly Connector[]; crowdedAt: number }> {
    await this.require(authorization, "settings.read", "connector.read");

    return {
      connectors: await this.connectors.all(),
      // The Support Agent chooses worse as the list grows (ticket 05), so the
      // screen says where that starts rather than the Bank finding out from a
      // Customer.
      crowdedAt: CROWDED_CONNECTOR_COUNT,
    };
  }

  /**
   * Registers one. **The credential is entered here and never read back** — not
   * by this controller, not by the Dashboard, not by the Administrator who
   * typed it. Changing one means entering a new one.
   */
  @Post("connectors")
  public async registerConnector(
    @Body() body: unknown,
    @Headers("authorization") authorization?: string,
  ): Promise<{ connector: Connector }> {
    const parsed = connectorBody.safeParse(body);
    const { account } = await this.requireQuietly(
      authorization,
      "connectors.write",
      "connector.registered",
      { connector: parsed.success ? parsed.data.name : null },
    );

    if (!parsed.success) throw new BadRequestException(problemIn(parsed.error));

    const registered = await this.connectors.register(parsed.data, this.actorFor(account));
    if (registered.outcome === "refused") throw new BadRequestException(registered.problem);

    return { connector: registered.connector };
  }

  /**
   * Changes one, and never its name.
   *
   * An absent `credential` leaves the stored one alone, which is what makes
   * *"fix the description"* something an Administrator can do without holding
   * the Bank's API key in their hand.
   */
  @Put("connectors/:connectorId")
  public async changeConnector(
    @Param("connectorId") connectorId: string,
    @Body() body: unknown,
    @Headers("authorization") authorization?: string,
  ): Promise<{ connector: Connector }> {
    const parsed = connectorChangesBody.safeParse(body);
    const { account } = await this.requireQuietly(
      authorization,
      "connectors.write",
      "connector.changed",
      { connectorId },
    );

    if (!parsed.success) throw new BadRequestException(problemIn(parsed.error));

    const changed = await this.connectors.change(connectorId, parsed.data, this.actorFor(account));
    if (changed.outcome === "refused") throw new BadRequestException(changed.problem);

    return { connector: changed.connector };
  }

  /**
   * Takes one out of the Support Agent's reach, in the very next turn.
   *
   * Retired rather than deleted: every audit row about a dispatch names it, and
   * evidence with a dangling reference is evidence nobody can read back.
   */
  @Post("connectors/:connectorId/retire")
  public async retireConnector(
    @Param("connectorId") connectorId: string,
    @Headers("authorization") authorization?: string,
  ): Promise<{ connector: Connector }> {
    const { account } = await this.requireQuietly(
      authorization,
      "connectors.write",
      "connector.retired",
      { connectorId },
    );

    const retired = await this.connectors.retire(connectorId, this.actorFor(account));
    if (retired.outcome === "refused") throw new BadRequestException(retired.problem);

    return { connector: retired.connector };
  }

  // --- Settings ---------------------------------------------------------------

  /**
   * The Bank's business hours and operations alert address.
   *
   * **Readable by a Support Officer, writable only by an Administrator.** Ticket
   * 28 drew that line and these two are the reason it was worth a role: the
   * hours decide what a Customer is told when nobody is there, and the address
   * decides who is woken at 3am.
   */
  @Get("settings")
  public async readSettings(
    @Headers("authorization") authorization?: string,
  ): Promise<PlatformSettings> {
    await this.require(authorization, "settings.read", "settings.read");
    return this.settings.all();
  }

  /**
   * One setting changed, and **one row that says what it was and what it now
   * is**.
   *
   * `requireQuietly` rather than `require`, so the row is written after the act
   * rather than before it — because the change record is the point here and half
   * of it does not exist until the write has happened. Every path below still
   * writes exactly one row: a role refusal from the check, a malformed value and
   * a successful change from here.
   */
  @Put("settings")
  public async writeSetting(
    @Body() body: unknown,
    @Headers("authorization") authorization?: string,
  ): Promise<{ written: true }> {
    const parsed = settingBody.safeParse(body);
    const key = parsed.success ? parsed.data.key : null;
    const { account } = await this.requireQuietly(authorization, "settings.write", "settings.write", {
      key,
    });

    if (!parsed.success) {
      await this.record(account, "settings.write", "refused", {
        key,
        rejected: `key must be one of ${SETTING_KEYS.join(", ")}`,
      });
      throw new BadRequestException(`key must be one of ${SETTING_KEYS.join(", ")}`);
    }

    const written = await this.settings.write(parsed.data.key, parsed.data.value, account.id);
    if (written.outcome === "refused") {
      await this.record(account, "settings.write", "refused", { key, rejected: written.problem });
      throw new BadRequestException(written.problem);
    }

    await this.record(account, "settings.write", "succeeded", {
      key,
      by: account.displayName,
      from: written.from,
      to: written.to,
    });
    return { written: true };
  }

  // --- The tariff --------------------------------------------------------------

  /**
   * What the Bank charges to move money, and **the one setting with its own
   * capability**.
   *
   * A Support Officer reads it and cannot write it. That distinction is the
   * whole reason the Dashboard has two roles rather than one: a fee change
   * alters what a Customer is charged, and a bank changes its fees under its own
   * regulator. `null` is a Bank that has entered none, and the Confirmation
   * screen says so honestly rather than inventing a number.
   */
  @Get("tariff")
  public async readTariff(
    @Headers("authorization") authorization?: string,
  ): Promise<{ tariff: Tariff | null }> {
    await this.require(authorization, "tariff.read", "tariff.read");
    return { tariff: await this.settings.tariff() };
  }

  /**
   * The change record the spec asked for: **who, when, from what, to what.**
   *
   * Who and when are the audit row's own columns; from and to come back from the
   * write itself, in the one statement that replaced the value. That is what
   * makes two Administrators saving at once produce two records that chain
   * rather than two that both claim to have replaced the same figure.
   */
  @Put("tariff")
  public async writeTariff(
    @Body() body: unknown,
    @Headers("authorization") authorization?: string,
  ): Promise<{ written: true }> {
    const { account } = await this.requireQuietly(authorization, "tariff.write", "tariff.write");

    // **The envelope has to be there**, and a missing `tariff` key is a `400`
    // rather than a withdrawal. `null` withdraws the Bank's tariff, so a
    // malformed body that defaulted to it would quietly take the Bank's fees off
    // every Confirmation screen — the loudest possible consequence of the
    // quietest possible mistake.
    const envelope = tariffBody.safeParse(body);
    if (!envelope.success) {
      await this.record(account, "tariff.write", "refused", { rejected: "no tariff was sent" });
      throw new BadRequestException(
        "Send { tariff: ... }. A tariff of null withdraws the one that is there.",
      );
    }

    const written = await this.settings.writeTariff(envelope.data.tariff, account.id);

    if (written.outcome === "refused") {
      await this.record(account, "tariff.write", "refused", { rejected: written.problem });
      throw new BadRequestException(written.problem);
    }

    await this.record(account, "tariff.write", "succeeded", {
      // **The name as it was at the time**, beside the account id the actor
      // column already carries. A change record read six months later must not
      // depend on the account still existing, or on its display name — which is
      // a thing this very screen can change — still saying what it said.
      by: account.displayName,
      from: written.from,
      to: written.to,
    });
    return { written: true };
  }

  /** `not_yours` is a `409`, for the same reason a lost claim is. */
  private finishOfficerAct(
    result:
      | { readonly outcome: "done"; readonly delivery: Delivery }
      | { readonly outcome: "not_yours" }
      | { readonly outcome: "not_found" },
  ): { delivery: Delivery } {
    switch (result.outcome) {
      case "done":
        return { delivery: result.delivery };
      case "not_yours":
        throw new ConflictException(
          "You are not holding this conversation. Claim it again to carry on.",
        );
      case "not_found":
        throw new NotFoundException("No such conversation.");
    }
  }

  @Post("sign-in")
  public async signIn(
    @Body() body: unknown,
    @Headers("user-agent") userAgent?: string,
  ): Promise<{ token: string; account: StaffAccount } | { mfaRequired: true; enrolled: boolean }> {
    const parsed = signInBody.safeParse(body);
    // A malformed request is refused with the same words as a wrong password,
    // so the shape of the form is not an oracle either.
    if (!parsed.success) throw new UnauthorizedException("Those details were not accepted.");

    const result = await this.authentication.authenticate(
      {
        method: "password",
        email: parsed.data.email,
        password: parsed.data.password,
        ...(parsed.data.totpCode === undefined ? {} : { totpCode: parsed.data.totpCode }),
      },
      { ...(userAgent === undefined ? {} : { userAgent }) },
    );

    switch (result.outcome) {
      case "signed_in":
        return { token: result.session.token, account: result.account };
      case "mfa_required":
        return { mfaRequired: true, enrolled: result.enrolled };
      case "refused":
        throw new UnauthorizedException("Those details were not accepted.");
    }
  }

  @Post("sign-out")
  public async signOut(@Headers("authorization") authorization?: string): Promise<{ ok: true }> {
    const who = await this.whoever(authorization);
    await this.authentication.signOut(who.sessionId, who.account.id);
    return { ok: true };
  }

  @Get("me")
  public async me(@Headers("authorization") authorization?: string): Promise<StaffAccount> {
    const { account } = await this.require(authorization, "customers.read", "staff.me_read");
    return account;
  }

  @Get("audit")
  public async readAudit(
    @Headers("authorization") authorization?: string,
    @Query("accountNumber") accountNumber?: string,
    @Query("conversationId") conversationId?: string,
    @Query("action") action?: string,
    @Query("outcome") outcome?: string,
    @Query("before") before?: string,
    @Query("limit") limit?: string,
  ): Promise<{ entries: readonly AuditEntry[] }> {
    // Recorded before the read, and with what was asked for. "Who went looking
    // for this Customer" is the question an investigation starts from.
    await this.require(authorization, "audit.read", "audit.read", {
      filters: {
        accountNumber: accountNumber ?? null,
        conversationId: conversationId ?? null,
        action: action ?? null,
        outcome: outcome ?? null,
      },
    });

    const parsedLimit = Number.parseInt(limit ?? "", 10);
    const entries = await this.audit.read({
      ...(accountNumber ? { accountNumber } : {}),
      ...(conversationId ? { conversationId } : {}),
      ...(action ? { action } : {}),
      ...(outcome ? { outcome } : {}),
      ...(before ? { before } : {}),
      ...(Number.isFinite(parsedLimit) ? { limit: parsedLimit } : {}),
    });

    return { entries };
  }

  /**
   * The Officer list. **Administrator only** — the role table gives a Support
   * Officer no access to this surface at all, because who else can get in is
   * not their business.
   */
  @Get("officers")
  public async listOfficers(
    @Headers("authorization") authorization?: string,
  ): Promise<{ officers: readonly StaffAccount[] }> {
    await this.require(authorization, "officers.read", "officers.read");
    return { officers: await this.staff.listAccounts() };
  }

  /**
   * How everybody after the first gets in. The first Administrator comes from
   * the explicit setup step and never from here.
   *
   * `requireQuietly` throughout this section, for the reason the tariff uses it:
   * these acts can be refused **after** the capability check — by a password too
   * short to store, by an account that is not there, or by the last-Administrator
   * rule below — and a row written before the act would say *succeeded* about an
   * act that then threw.
   */
  @Post("officers")
  public async createOfficer(
    @Body() body: unknown,
    @Headers("authorization") authorization?: string,
  ): Promise<StaffAccount> {
    const parsed = createOfficerBody.safeParse(body);
    const problem = parsed.success ? passwordProblem(parsed.data.password) : "are incomplete";
    const asked = {
      // The email of somebody an Administrator tried to create is worth having.
      // Never the password, which the audit writer would redact anyway.
      requestedEmail: parsed.success ? parsed.data.email : null,
      requestedRole: parsed.success ? parsed.data.role : null,
    };

    const { account: actor } = await this.requireQuietly(
      authorization,
      "officers.write",
      "officers.write",
      asked,
    );

    if (!parsed.success || problem) {
      throw await this.refused(actor, "officers.write", { ...asked, rejected: problem ?? "are incomplete" },
        new BadRequestException(`Those details ${problem ?? "are incomplete"}.`));
    }

    const created = await this.staff.createAccount(parsed.data);
    await this.record(actor, "officers.write", "succeeded", { ...asked, officerId: created.id });
    return created;
  }

  /**
   * An Officer's **display name**, role and access.
   *
   * The display name is not cosmetic: it is what the Customer is told when this
   * person takes over a conversation, in both directions. A Bank that cannot
   * change it is a Bank whose Customers are told a name that is wrong.
   *
   * Two refusals worth naming, and both are `409` rather than `403` — the
   * Administrator is allowed to do this, just not to this account right now:
   *
   * - **The last Administrator cannot be demoted or disabled.** The setup step
   *   declines once any account exists, so a deployment that loses its last one
   *   has no route back except somebody with database access.
   * - **Nobody disables themselves.** Their sessions would be killed by the same
   *   call, so the answer to *"did that work"* would be the sign-in page.
   */
  @Put("officers/:officerId")
  public async updateOfficer(
    @Param("officerId") officerId: string,
    @Body() body: unknown,
    @Headers("authorization") authorization?: string,
  ): Promise<StaffAccount> {
    const parsed = updateOfficerBody.safeParse(body);
    const asked = { officerId, change: parsed.success ? parsed.data : null };
    const { account: actor } = await this.requireQuietly(
      authorization,
      "officers.write",
      "officers.write",
      asked,
    );

    if (!parsed.success) {
      throw await this.refused(actor, "officers.write", { ...asked, rejected: "nothing was asked to change" },
        new BadRequestException("Nothing was asked to change."));
    }

    const target = await this.staff.findById(officerId);
    if (!target) {
      throw await this.refused(actor, "officers.write", { ...asked, rejected: "no such account" },
        new NotFoundException("No such staff account."));
    }

    const stopped = await this.wouldLeaveNoWayIn(actor, target, parsed.data);
    if (stopped) {
      throw await this.refused(actor, "officers.write", { ...asked, rejected: stopped },
        new ConflictException(stopped));
    }

    const updated = await this.staff.updateAccount(officerId, parsed.data);
    if (!updated) {
      throw await this.refused(actor, "officers.write", { ...asked, rejected: "no such account" },
        new NotFoundException("No such staff account."));
    }

    // **From what, to what** — the same change-record shape the tariff and the
    // settings use, decided once rather than per screen (ticket 22). A display
    // name is what a Customer is told on a Handoff, so *"what was it before"* is
    // a question about a conversation somebody had, not a detail.
    await this.record(actor, "officers.write", "succeeded", {
      ...asked,
      by: actor.displayName,
      from: {
        displayName: target.displayName,
        role: target.role,
        disabled: target.disabled,
      },
      to: {
        displayName: updated.displayName,
        role: updated.role,
        disabled: updated.disabled,
      },
    });
    return updated;
  }

  /**
   * A new password for somebody who has lost theirs.
   *
   * **Every session that account held is killed by the same act**, which is what
   * separates a reset from a change. Somebody asking for one has usually lost
   * control of something, and a reset that left the old browser signed in would
   * answer the wrong half of that.
   *
   * The password is chosen by the Administrator and spoken to its owner, who can
   * change it afterwards. A self-service reset needs a channel to send a link
   * over that the Bank has not yet named — it is a real gap and it is recorded
   * on the ticket rather than guessed at here.
   */
  @Post("officers/:officerId/password")
  public async resetOfficerPassword(
    @Param("officerId") officerId: string,
    @Body() body: unknown,
    @Headers("authorization") authorization?: string,
  ): Promise<{ reset: true; sessionsEnded: number }> {
    const parsed = passwordBody.safeParse(body);
    const problem = parsed.success ? passwordProblem(parsed.data.password) : "are incomplete";
    // Never the password itself, which the audit writer would redact anyway.
    const asked = { officerId };

    const { account: actor } = await this.requireQuietly(
      authorization,
      "officers.write",
      "officers.password_reset",
      asked,
    );

    if (!parsed.success || problem) {
      throw await this.refused(actor, "officers.password_reset", { ...asked, rejected: problem ?? "are incomplete" },
        new BadRequestException(`Those details ${problem ?? "are incomplete"}.`));
    }

    const target = await this.staff.findById(officerId);
    if (!target) {
      throw await this.refused(actor, "officers.password_reset", { ...asked, rejected: "no such account" },
        new NotFoundException("No such staff account."));
    }

    await this.staff.setPassword(officerId, parsed.data.password);
    const sessionsEnded = await this.staff.revokeAllSessions(officerId);

    await this.record(actor, "officers.password_reset", "succeeded", { ...asked, sessionsEnded });
    return { reset: true, sessionsEnded };
  }

  /**
   * The sessions one account is holding, so signing them out is not a blind act.
   *
   * `officers.read`, which is Administrator-only — who else is signed in is no
   * more a Support Officer's business than who else can get in. Ticket 28 put
   * `user_agent` and `ip_address` on the table for this screen and nothing read
   * them until now.
   */
  @Get("officers/:officerId/sessions")
  public async readOfficerSessions(
    @Param("officerId") officerId: string,
    @Headers("authorization") authorization?: string,
  ): Promise<{ sessions: readonly LiveSession[] }> {
    await this.require(authorization, "officers.read", "officers.read", { officerId });

    const target = await this.staff.findById(officerId);
    if (!target) throw new NotFoundException("No such staff account.");

    return { sessions: await this.staff.liveSessionsFor(officerId) };
  }

  /**
   * Signs one member of staff out everywhere. A stolen laptop, or a leaver.
   *
   * `revokeAllSessions` was built and tested by ticket 28 with nothing calling
   * it from a route. This is that route, and it is the difference between the
   * Bank being able to end somebody's access now and being able to end it within
   * eight hours.
   */
  @Post("officers/:officerId/sessions/revoke")
  public async revokeOfficerSessions(
    @Param("officerId") officerId: string,
    @Headers("authorization") authorization?: string,
  ): Promise<{ sessionsEnded: number }> {
    await this.require(authorization, "officers.write", "staff.sessions_revoked", { officerId });

    const target = await this.staff.findById(officerId);
    if (!target) throw new NotFoundException("No such staff account.");

    return { sessionsEnded: await this.staff.revokeAllSessions(officerId) };
  }

  /**
   * Why this change is refused, or nothing. **Neither case may leave the
   * deployment without a way in.**
   *
   * A sentence rather than a thrown exception, so the caller records it as the
   * reason on the audit row and raises it in one place.
   */
  private async wouldLeaveNoWayIn(
    actor: StaffAccount,
    target: StaffAccount,
    changes: { role?: Role; disabled?: boolean },
  ): Promise<string | undefined> {
    if (target.id === actor.id && changes.disabled === true) {
      return "You cannot disable your own account.";
    }

    const losing =
      target.role === "administrator" &&
      !target.disabled &&
      (changes.disabled === true || changes.role === "support_officer");

    if (losing && (await this.staff.liveAdministrators()) <= 1) {
      return "This is the last Administrator who can sign in. Make somebody else an Administrator first.";
    }

    return undefined;
  }

  /**
   * Records why an act was refused, and hands back the exception to raise.
   *
   * `throw await this.refused(…)` at every call site, so the row and the
   * refusal cannot come apart — the alternative is two statements and an early
   * return somebody eventually writes without the first one.
   */
  private async refused(
    account: StaffAccount,
    action: DashboardAction,
    detail: Record<string, unknown>,
    error: Error,
  ): Promise<Error> {
    await this.record(account, action, "refused", detail);
    return error;
  }

  // --- Enrolling a second factor -----------------------------------------------

  /**
   * **Unauthenticated, and it has to be.** An Administrator who has not enrolled
   * cannot sign in at all, so there is no session to do this from.
   *
   * The password is the whole of the check, which is correct rather than a
   * compromise: an account with no second factor has exactly one, and somebody
   * holding it can already do everything the account can. The service refuses an
   * account that **is** enrolled, which is the case where a password alone would
   * be replacing a factor rather than adding one.
   */
  @Post("mfa/enrolment")
  public async beginMfaEnrolment(
    @Body() body: unknown,
  ): Promise<{ secret: string; uri: string }> {
    const parsed = mfaEnrolmentBody.safeParse(body);
    if (!parsed.success) throw new UnauthorizedException("Those details were not accepted.");

    const offered = await this.authentication.beginMfaEnrolment(
      { method: "password", email: parsed.data.email, password: parsed.data.password },
      // The Bank's own name, so the entry in somebody's authenticator says who
      // it is for. Configuration rather than a constant, like everything else
      // that differs between deployments.
      this.config.bankName,
    );

    // One refusal for every reason — a wrong password, an unknown address and an
    // account that is already enrolled are the same sentence.
    if (offered.outcome === "refused") {
      throw new UnauthorizedException("Those details were not accepted.");
    }

    return { secret: offered.secret, uri: offered.uri };
  }

  @Post("mfa/enrolment/confirm")
  public async confirmMfaEnrolment(@Body() body: unknown): Promise<{ enrolled: true }> {
    const parsed = mfaConfirmationBody.safeParse(body);
    if (!parsed.success) throw new UnauthorizedException("Those details were not accepted.");

    const done = await this.authentication.completeMfaEnrolment(
      { method: "password", email: parsed.data.email, password: parsed.data.password },
      parsed.data.totpCode,
    );

    if (done.outcome === "refused") {
      throw new UnauthorizedException("Those details were not accepted.");
    }

    return { enrolled: true };
  }

  /**
   * Generates the **Snippet** and the secret the Bank's backend signs with.
   *
   * **Administrator only**, and the reason is the second half rather than the
   * first: the Snippet is four lines that will sit inside a mobile application,
   * but the secret it goes with is what decides whose balance in-app chat
   * returns. That makes this a high-privilege surface alongside Connector
   * registration rather than a settings screen — ticket 22 settled it, and MFA
   * is required for the role.
   *
   * The secret is in this response and in no other. Issuing a second one does
   * **not** retire the first: the Bank's backend is still signing with it, and
   * a rotation that breaks in-app chat the moment the button is pressed is a
   * rotation nobody performs.
   */
  @Post("snippet")
  public async issueSnippet(
    @Body() body: unknown,
    @Headers("authorization") authorization?: string,
  ): Promise<IssuedSnippet> {
    const parsed = issueSnippetBody.safeParse(body);
    const label = parsed.success ? (parsed.data.label ?? "") : "";

    const { account } = await this.require(authorization, "snippet.write", "snippet.issued", {
      label,
      contractVersion: CURRENT_CONTRACT_VERSION,
    });

    const issued = await this.snippets.issue({ label, issuedBy: account.id });

    return {
      snippet: snippetFor(CURRENT_CONTRACT_VERSION, this.config.platformPublicBaseUrl),
      secret: issued.secret,
      secretId: issued.record.id,
      contractVersion: issued.record.contractVersion,
      signingInstructions: signingInstructions(CURRENT_CONTRACT_VERSION),
    };
  }

  /**
   * The Snippet as it can be read afterwards, and every secret's *existence*.
   *
   * Readable by a Support Officer because it carries nothing a Support Officer
   * may not see: four lines the Bank has already pasted into a shipped mobile
   * application, and a list of when secrets were issued and by whom. The
   * secrets themselves are not here and are not reachable from any route.
   */
  @Get("snippet")
  public async readSnippet(
    @Headers("authorization") authorization?: string,
  ): Promise<SnippetView> {
    await this.require(authorization, "settings.read", "snippet.read");

    return {
      current: this.snippetForVersion(CURRENT_CONTRACT_VERSION),
      versions: CONTRACT_VERSIONS.map((version) => this.snippetForVersion(version)),
      secrets: await this.snippets.list(),
    };
  }

  private snippetForVersion(version: ContractVersion): SnippetForVersion {
    return {
      contractVersion: version,
      snippet: snippetFor(version, this.config.platformPublicBaseUrl),
      signingInstructions: signingInstructions(version),
    };
  }

  /**
   * Retires one signing secret.
   *
   * The other half of rotation, and the answer to a leaked one: every envelope
   * signed with it stops verifying on the next message, with no redeploy and
   * without touching whatever else the Bank has live.
   */
  @Post("snippet/secrets/:secretId/revoke")
  public async revokeSnippetSecret(
    @Param("secretId") secretId: string,
    @Headers("authorization") authorization?: string,
  ): Promise<{ revoked: boolean }> {
    await this.require(authorization, "snippet.write", "snippet.secret_revoked", { secretId });

    return { revoked: await this.snippets.revoke(secretId) };
  }

  /** Resolves the bearer token, or refuses. */
  private async whoever(
    authorization: string | undefined,
  ): Promise<{ account: StaffAccount; sessionId: string }> {
    const token = BEARER.exec(authorization ?? "")?.[1];
    const who = await this.authentication.accountForToken(token);
    // Every request re-reads the session server-side, which is what makes
    // revocation immediate rather than eventual.
    if (!who) throw new UnauthorizedException("Sign in again.");
    return who;
  }

  /**
   * The same check as {@link require}, but **recording only a refusal**.
   *
   * For the three acts where the service itself writes the row: an Officer's
   * claim, reply and resolve are recorded with what actually happened —
   * including how the message reached the Customer — and a second row from here
   * would be the same event under the same name twice. The refusal still has to
   * be recorded here, because a refused act never reaches the service at all.
   */
  private requireQuietly(
    authorization: string | undefined,
    capability: Capability,
    action: DashboardAction,
    detail: Record<string, unknown> = {},
    accountNumber?: string,
  ): Promise<{ account: StaffAccount; sessionId: string }> {
    return this.check(authorization, capability, action, detail, "refusals only", accountNumber);
  }

  /**
   * Resolves the caller, checks one capability, and **records the attempt
   * either way** — a refusal is exactly what an insider-threat investigation
   * wants to see, and it cannot be reconstructed afterwards.
   *
   * @param accountNumber **Which Customer this was about.** The audit table's
   * own column rather than a `detail` field, because *"who has looked at this
   * account"* is a query the Bank will run and a value buried in JSON is one it
   * cannot run against.
   */
  private require(
    authorization: string | undefined,
    capability: Capability,
    action: DashboardAction,
    detail: Record<string, unknown> = {},
    accountNumber?: string,
  ): Promise<{ account: StaffAccount; sessionId: string }> {
    return this.check(authorization, capability, action, detail, "always", accountNumber);
  }

  /**
   * The one capability check. `recording` is the only thing the two callers
   * above differ by, and it is a policy rather than a flag: **a refusal is
   * always written**, because it cannot be reconstructed afterwards and is
   * exactly what an insider-threat investigation wants to see.
   */
  private async check(
    authorization: string | undefined,
    capability: Capability,
    action: DashboardAction,
    detail: Record<string, unknown>,
    recording: "always" | "refusals only",
    accountNumber?: string,
  ): Promise<{ account: StaffAccount; sessionId: string }> {
    const who = await this.whoever(authorization);
    const permitted = can(who.account.role, capability);

    if (!permitted || recording === "always") {
      await this.record(
        who.account,
        action,
        permitted ? "succeeded" : "refused",
        { ...detail, capability, role: who.account.role },
        accountNumber,
      );
    }

    if (!permitted) throw new ForbiddenException("Your role does not allow that.");
    return who;
  }

  private async record(
    account: StaffAccount,
    action: DashboardAction,
    outcome: AuditOutcome,
    detail: Record<string, unknown>,
    accountNumber?: string,
  ): Promise<void> {
    await this.audit.record({
      action,
      actor: { kind: account.role === "administrator" ? "administrator" : "officer", id: account.id },
      outcome,
      ...(accountNumber === undefined ? {} : { accountNumber }),
      detail,
    });
  }

  /** Who this act is attributed to in the rows the services below write. */
  private actorFor(account: StaffAccount): Actor {
    return {
      kind: account.role === "administrator" ? "administrator" : "officer",
      id: account.id,
    };
  }
}

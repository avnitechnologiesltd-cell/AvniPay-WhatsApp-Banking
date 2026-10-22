import { randomBytes } from "node:crypto";

import type { MiddlewareConfig, PlatformConfig } from "@avni/config";
import {
  applyMigrations,
  applyRoleGrants,
  createPool,
  readMigrations,
  type Pool,
} from "@avni/db";
import {
  createTestClock,
  startFakeBankIdentity,
  startFakeBankOne,
  startFakeConnector,
  startFakeGroq,
  startFakeObjectStore,
  startFakeWhatsApp,
  type FakeAccount,
  type FakeConnector,
  type FakeAccountName,
  type FakeBankIdentity,
  type FakeBankOne,
  type FakeGroq,
  type FakeMedia,
  type FakeObjectStore,
  type FakeIdentityAccount,
  type FakeTransferBehaviour,
  type TestClock,
  openFlowResponse,
  sealFlowRequest,
  signFlowBody,
  writeFlowsKeypair,
  TEST_ENCRYPTION_KEY,
  type FakeWhatsApp,
} from "@avni/fakes";
import {
  AuditRepository,
  BindingsRepository,
  HandoffService,
  StaffRepository,
  TransactionPinService,
  createMiddlewareApplication,
  type Connector,
  type ConnectorDispatcher,
  type DispatchOutcome,
  type HandoffRaised,
  type IssuedSnippet,
  generateTotpSecret,
  totp,
} from "@avni/middleware";
import { createPlatformApplication } from "@avni/platform";
import { startService, type RunningService } from "@avni/service";

/** The Dashboard's own type, so a journey test and the endpoint cannot drift. */
export type { IssuedSnippet };

/**
 * The whole platform, booted for one test.
 *
 * ```
 * real:  Platform · Middleware · Postgres · the HTTP between them
 * fake:  BankOne | Groq | WhatsApp Graph
 * ```
 *
 * The four systems we do not own are the only seam. Everything we build stays
 * real, including the database — reference deduplication, one-live-Binding-per
 * -account and the shared lockout counter are money-correctness rules Postgres
 * enforces, and an in-memory fake would reimplement them approximately and then
 * be the thing these tests assert against.
 */

const ADMIN_URL = process.env["TEST_DATABASE_URL"] ?? "postgres://avni:avni@localhost:5432/avni";

export const AUTH_TOKEN = "test-auth-token";
export const INSTITUTION_CODE = "test-institution";
export const GROQ_API_KEY = "test-groq-key";
export const GRAPH_TOKEN = "test-graph-token";
export const PHONE_NUMBER_ID = "test-phone-number-id";
export const VERIFY_TOKEN = "test-verify-token";
export const APP_SECRET = "test-app-secret";
export const INTENT_MODEL = "openai/gpt-oss-20b";
/**
 * The larger of Groq's two production models, and the Support Agent's.
 *
 * They differ only in size — same family, same prompt format — so the split is
 * not about capability shopping. It is that structured output and tool use are
 * mutually exclusive on Groq, which makes Intent resolution and the Support
 * Agent two calls whatever model each runs on.
 */
export const SUPPORT_MODEL = "openai/gpt-oss-120b";

/**
 * The Library budget the harness boots with, in tokens.
 *
 * Deliberately **not** the production default of 8,000. A budget a test can
 * exhaust with two paragraphs is a budget a test can assert against; at 8,000
 * the corpus needed to prove the cap works would be thirty kilobytes of invented
 * policy nobody would read.
 */
export const LIBRARY_BUDGET_TOKENS = 400;
/**
 * The Bank's own name and NIBSS code — what makes a transfer intra-bank.
 *
 * `099999` is a placeholder that **no bank in the NIBSS list claims**, and it is
 * chosen that way on purpose: an earlier value here was `090110`, which is VFD
 * Microfinance Bank's real code, so a test naming VFD would have been talking to
 * this Bank without saying so.
 */
export const BANK_NAME = "Example MFB";
export const BANK_CODE = "099999";

export interface Harness {
  readonly platformUrl: string;
  readonly middlewareUrl: string;
  /** The public half of the throwaway Flows keypair, for sealing a request. */
  readonly flowsPublicKeyPem: string;
  readonly bankOne: FakeBankOne;
  readonly groq: FakeGroq;
  readonly whatsapp: FakeWhatsApp;
  /** The Bank's identity API — the fourth system on the seam. */
  readonly bankIdentity: FakeBankIdentity;
  /**
   * **A Bank API somebody registered as a Connector.**
   *
   * v1 ships with zero Connectors, so this is the only thing there is to
   * dispatch against — ticket 18 made the examples ours rather than an ask to
   * the Bank. What a test asserts on it is the *request*: a `POST`, a JSON
   * envelope, the credential in the header the Bank named, and an
   * `account_number` that came from the Binding rather than from a model.
   */
  readonly connector: FakeConnector;
  /**
   * Where the Middleware was asked to send each dispatch, in order.
   *
   * The registered endpoint, as the dispatcher received it — which is what makes
   * *"nothing unregistered can be called"* assertable when the network itself is
   * standing in for the internet.
   */
  readonly dispatchedTo: readonly string[];
  /**
   * Registers a Connector the way an Administrator does — **through the
   * Dashboard's own endpoint**, because the role check is half of what is being
   * built.
   */
  readonly registerConnector: (connector: NewConnectorForTest) => Promise<Connector>;
  /**
   * One query against the Middleware's own database.
   *
   * For the two claims that cannot be made through an endpoint, because the
   * whole point of them is that no endpoint exists: a credential is **not
   * readable back**, and what is in the column is ciphertext rather than the
   * value somebody typed.
   */
  readonly query: <T extends Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ) => Promise<readonly T[]>;
  /**
   * Object storage, where a Customer's attachments land.
   *
   * Asserted against directly, because *"the Platform writes it and only the
   * Dashboard reads it"* is a claim about two credentials and one bucket, and
   * the bucket is the only place both halves are visible at once.
   */
  readonly objectStore: FakeObjectStore;
  /**
   * Time, which a test may move.
   *
   * A 1-hour lockout and a 90-day dormancy window are behaviour, not timing
   * details, and the alternative to this is a suite that asserts neither.
   */
  readonly clock: TestClock;
  /**
   * Binds a number to an account without walking the Flow.
   *
   * Enrollment is real from ticket 29 onward and `tests/enrollment.test.ts`
   * drives it end to end. This stays for the journeys that are *about* something
   * else and simply need a Customer who is already linked.
   */
  readonly seedBinding: (channelIdentity: string, accountNumber: string) => Promise<void>;
  /**
   * Sets an account's Transaction PIN without walking enrollment.
   *
   * The same reason `seedBinding` exists: a transfer journey is about the
   * transfer, and `tests/enrollment.test.ts` already drives the screen that sets
   * one. It goes through the real service, so the stored hash is the real
   * argon2id one and the shared lockout counter is the real counter.
   */
  readonly seedPin: (accountNumber: string, pin: string) => Promise<void>;
  /**
   * Creates a member of staff and signs them in, returning their token.
   *
   * The Dashboard's surfaces all sit behind a session, so a test that reads one
   * needs somebody to be looking — which is the point of auditing reads.
   *
   * The credentials come back too, for the one test that is about the sign-in
   * itself rather than about what happens afterwards.
   */
  readonly signInStaff: (
    role?: "support_officer" | "administrator",
  ) => Promise<{ token: string; accountId: string; email: string; password: string }>;
  readonly revokeBindingsFor: (channelIdentity: string) => Promise<void>;
  /**
   * Stops the Platform and starts a fresh one on the same port.
   *
   * For the rules that must not live in one process's memory. The Platform is
   * the stateless half — every conversation, Binding and Mandate is in the
   * Middleware's database — and a test that never restarts it would not notice
   * something quietly becoming a per-process fact.
   */
  readonly restartPlatform: () => Promise<void>;
  /**
   * Stops the Platform and leaves it stopped.
   *
   * For the one claim that cannot be made any other way: a **sealed surface
   * terminates at the Middleware**, so a Customer who has already been handed
   * one can enter their Transaction PIN and move money with the Platform not
   * running at all. A test that merely inspected request bodies would be
   * asserting that the PIN does not go through the Platform *today*; this
   * asserts that there is nowhere for it to go.
   */
  readonly stopPlatform: () => Promise<void>;
  /**
   * Generates a Snippet the way an Administrator does, through the Dashboard.
   *
   * Through the real endpoint rather than the repository, because *"an
   * Administrator generates a Snippet and its signing secret from the
   * Dashboard"* is the thing being built and the role check is half of it.
   */
  readonly generateSnippet: () => Promise<IssuedSnippet>;
  /**
   * Puts a document in the Library the way an Administrator does — **through
   * the Dashboard's own endpoints, and in two steps**.
   *
   * Two steps because that is the design: uploading leaves a draft nobody can
   * quote, and publishing is a separate act somebody takes after reading the
   * extracted text. A helper that did both in one call would be a helper that
   * made the distinction untestable, so `publish` is a parameter and
   * `tests/library.test.ts` sets it both ways.
   */
  readonly publishToLibrary: (document: LibraryUpload) => Promise<PublishedDocument>;
  /** Takes a live version back out of the Agent's reach, as an Administrator does. */
  readonly withdrawFromLibrary: (versionId: string) => Promise<void>;
  /**
   * Claims and resolves every open Handoff, the way an Officer does.
   *
   * For the journeys that are about something else and simply need the Support
   * Agent back. **A Handoff is a transfer of ownership**, so a test whose
   * Customer trips one and then carries on talking is talking to nobody until
   * this has run — which is the behaviour rather than a quirk of the harness,
   * and `tests/handoff.test.ts` is where that is asserted rather than worked
   * around.
   */
  readonly resolveHandoffs: () => Promise<void>;
  /**
   * Raises **Handoff trigger 3** the way a Gated Connector's dispatch will.
   *
   * The only trigger with no caller in this release: Gated Connectors arrive
   * with ticket 40.
   * It is built now because the closed set of six is what this slice owns, and
   * it is reached through the service here because **there is deliberately no
   * HTTP route to it** — the Platform never sees a Transaction PIN, so it cannot
   * know one was wrong, and a route would let a Customer's text say otherwise.
   */
  readonly gatedPinFailed: (conversationId: string, connector: string) => Promise<HandoffRaised>;
  readonly stop: () => Promise<void>;
}

export interface HarnessOptions {
  readonly accounts?: readonly FakeAccount[];
  /**
   * Operations the Bank's token does not carry. `["GetTransactions"]` is the first
   * deployment's real staging answer (Appendix A.1), and `bankOne.setEntitled`
   * walks a running test across the day the Bank turns one on.
   */
  readonly unentitled?: readonly string[];
  /** Accounts the Bank's identity API will resolve, with their destinations. */
  readonly identityAccounts?: readonly FakeIdentityAccount[];
  /**
   * What name enquiry resolves, per account **and bank**. Nothing resolves that
   * is not listed — an account number nobody seeded is one BankOne does not
   * hold, which is what a Customer's mistyped digit looks like.
   */
  readonly names?: readonly FakeAccountName[];
  /** How a transfer and its status query behave. Defaults to plain success. */
  readonly transfer?: FakeTransferBehaviour;
  /** Files the Bank's WhatsApp account is holding, keyed by media id. */
  readonly media?: readonly FakeMedia[];
}

/**
 * Where a handset would reach the Platform in a real deployment.
 *
 * A fixed value rather than the Platform's ephemeral test URL: it is what the
 * Middleware writes into a generated Snippet, and a test asserting the Snippet
 * points at *configuration* is asserting the thing that matters. The Widget
 * itself is fetched from `harness.platformUrl`, which is where it really is.
 */
export const PLATFORM_PUBLIC_BASE_URL = "https://app.bank.example";

/**
 * The Bank's own three-digit CBN code, under which the account numbers below
 * carry a valid NUBAN check digit. `030` is the placeholder the enrollment
 * prototype validated both BankOne reference account numbers against.
 */
export const NUBAN_BANK_CODE = "030";
export const ATTACHMENT_BUCKET = "avni-attachments";
/**
 * Two credentials against one bucket, and they are **different strings on
 * purpose**.
 *
 * The fake does not enforce a bucket policy — production does that — but a
 * harness that gave both deployables one key would quietly make the split
 * untestable, and the first thing anybody would check is whether the two are
 * even distinct.
 */
export const PLATFORM_STORE_KEY = "platform-writes-only";
export const MIDDLEWARE_STORE_KEY = "middleware-reads-only";
export const DECOY_SECRET = "a-test-decoy-secret-long-enough";
export const IDENTITY_API_KEY = "test-identity-key";

const withDatabase = (connectionString: string, name: string): string => {
  const url = new URL(connectionString);
  url.pathname = `/${name}`;
  return url.toString();
};

/** The same database, connected to as a role the migration step created. */
const asRole = (connectionString: string, role: string, password: string): string => {
  const url = new URL(connectionString);
  url.username = role;
  url.password = password;
  return url.toString();
};

const ROLE_PASSWORD = "harness-role-password";

/** One document, as a test puts it in the Library. */
export interface LibraryUpload {
  readonly title: string;
  /** A new version of a document that already exists. */
  readonly documentId?: string;
  /** The Bank's own date for the policy, `YYYY-MM-DD`. A citation names it. */
  readonly versionDate?: string;
  /** Defaults to Markdown, which is what a policy looks like once retyped. */
  readonly mediaType?: string;
  readonly fileName?: string;
  /** The document itself. A string, or the bytes of a real file. */
  readonly text: string | Uint8Array;
  /** Whether to take the second step. Defaults to `true`. */
  readonly publish?: boolean;
}

export interface PublishedDocument {
  readonly documentId: string;
  readonly versionId: string;
}

/** One Connector, as a test registers it. */
export interface NewConnectorForTest {
  readonly name: string;
  readonly description?: string;
  /**
   * **A real-looking address on the public internet**, and it has to be: the
   * registration form refuses anything else, and that refusal is the security
   * property. Where the call actually goes is the dispatcher's business, and in
   * a test that is the fake below.
   */
  readonly endpoint?: string;
  readonly gated?: boolean;
  readonly parameters?: readonly {
    readonly name: string;
    readonly type: "string" | "number" | "boolean";
    readonly required?: boolean;
    readonly description?: string;
  }[];
  readonly credentialHeader?: string;
  readonly credential?: string;
  /** The signed-in Administrator to register as. One is made if absent. */
  readonly token?: string;
}

export const startHarness = async (options: HarnessOptions = {}): Promise<Harness> => {
  const admin = createPool(ADMIN_URL);
  const suffix = randomBytes(6).toString("hex");
  const databaseName = `avni_e2e_${suffix}`;
  await admin.query(`create database ${databaseName}`);
  const databaseUrl = withDatabase(ADMIN_URL, databaseName);

  /**
   * **The Platform connects as its own granted role, not as the owner.**
   *
   * Every journey test in this repository therefore runs against the real
   * privilege separation: the Platform's login can read `schema_migrations` and
   * nothing else, exactly as it can in the Bank's deployment. If the Platform
   * ever grows a query against a table it holds no grant on, these tests are
   * where that is discovered — which is the whole reason to pay for it here
   * rather than only in `tests/database-roles.test.ts`.
   *
   * The Middleware stays on the owning login. Its grants are read-and-write on
   * everything, so a separate role would prove nothing this costs nothing to
   * skip.
   */
  const platformRole = `avni_platform_${suffix}`;
  const platformDatabaseUrl = asRole(databaseUrl, platformRole, ROLE_PASSWORD);

  // The explicit release step, run the way an operator runs it: the migrations,
  // and then the grants.
  const migrator = createPool(databaseUrl);
  await applyMigrations(migrator, readMigrations());
  await applyRoleGrants(migrator, {
    middleware: { role: `avni_middleware_${suffix}`, password: ROLE_PASSWORD },
    platform: { role: platformRole, password: ROLE_PASSWORD },
  });
  await migrator.end();

  const bankOne = await startFakeBankOne({
    authToken: AUTH_TOKEN,
    institutionCode: INSTITUTION_CODE,
    accounts: options.accounts ?? [],
    names: options.names ?? [],
    ...(options.unentitled ? { unentitled: options.unentitled } : {}),
    ...(options.transfer ? { transfer: options.transfer } : {}),
  });
  const groq = await startFakeGroq({ apiKey: GROQ_API_KEY });
  const flowsKey = writeFlowsKeypair();
  const whatsapp = await startFakeWhatsApp({
    apiToken: GRAPH_TOKEN,
    phoneNumberId: PHONE_NUMBER_ID,
    ...(options.media ? { media: options.media } : {}),
  });
  const objectStore = await startFakeObjectStore({ bucket: ATTACHMENT_BUCKET });
  const bankIdentity = await startFakeBankIdentity({
    apiKey: IDENTITY_API_KEY,
    accounts: options.identityAccounts ?? [],
  });
  const connector = await startFakeConnector();
  const clock = createTestClock();

  /**
   * **The network, standing in for itself** — the second seam in this harness
   * and the same kind as the clock.
   *
   * A Connector endpoint is on the public internet *by policy*: the real
   * dispatcher resolves the hostname and refuses loopback, private, link-local
   * and reserved addresses on the **resolved address** at connect time. A fake
   * Bank API is on `127.0.0.1` by necessity, so every test would be refused —
   * and the way to fix that is emphatically not to weaken the rule.
   *
   * So this stands in for the connection and nothing else. Everything above it
   * is real: the registration form still refuses a non-HTTPS or private
   * endpoint, the arguments are still checked against the Bank's declaration,
   * the Transaction PIN is still taken through the sealed surface, and the audit
   * row is still written here. What the real dispatcher does instead is
   * `apps/middleware/src/connectors/dispatcher.test.ts`, against injected DNS.
   */
  const dispatchedTo: string[] = [];
  const dispatcher: ConnectorDispatcher = {
    send: async (call): Promise<DispatchOutcome> => {
      dispatchedTo.push(call.endpoint);

      const response = await fetch(connector.url, {
        method: "POST",
        headers: { ...call.headers, "content-type": "application/json" },
        body: JSON.stringify(call.body),
      });

      return { outcome: "answered", status: response.status, body: await response.text() };
    },
  };

  const middlewareConfig: MiddlewareConfig = {
    environment: "development",
    logLevel: "warn",
    databaseUrl,
    port: 0,
    publicBaseUrl: "http://127.0.0.1:1",
    platformPublicBaseUrl: PLATFORM_PUBLIC_BASE_URL,
    credentialEncryptionKey: TEST_ENCRYPTION_KEY,
    bankName: BANK_NAME,
    bankOne: {
      webApiBaseUrl: bankOne.url,
      thirdPartyApiBaseUrl: bankOne.url,
      apiKey: AUTH_TOKEN,
      institutionCode: INSTITUTION_CODE,
      bankCode: BANK_CODE,
      productCode: "test-product",
      officerCode: "test-officer",
    },
    whatsapp: {
      graphApiBaseUrl: whatsapp.url,
      apiToken: GRAPH_TOKEN,
      verifyToken: VERIFY_TOKEN,
      phoneNumberId: PHONE_NUMBER_ID,
      appSecret: APP_SECRET,
      flows: {
        privateKeyPath: flowsKey.keyPath,
        passphrase: flowsKey.passphrase,
        sendMoneyFlowId: "test-send-money-flow",
        setPinFlowId: "test-set-pin-flow",
        enrollmentFlowId: "test-enrollment-flow",
      },
      reopenTemplate: { name: "support_update_available", language: "en" },
    },
    bankIdentity: { baseUrl: bankIdentity.url, apiKey: IDENTITY_API_KEY },
    handoff: { claimIdleMinutes: 30 },
    library: { retrievalBudgetTokens: LIBRARY_BUDGET_TOKENS },
    attachments: {
      endpoint: objectStore.url,
      bucket: ATTACHMENT_BUCKET,
      region: "us-east-1",
      accessKeyId: MIDDLEWARE_STORE_KEY,
      secretAccessKey: `${MIDDLEWARE_STORE_KEY}-secret`,
    },
    enrollment: {
      nubanBankCode: NUBAN_BANK_CODE,
      decoySecret: DECOY_SECRET,
      bindingDormancyDays: 90,
    },
    auditRetentionDays: 0,
  };

  const middlewareApp = await createMiddlewareApplication(middlewareConfig, clock, dispatcher);
  const middleware: RunningService = await startService({
    app: middlewareApp.app,
    pool: middlewareApp.pool,
    logger: middlewareApp.logger,
    service: "middleware",
    port: 0,
    databaseAccess: "holds-the-security-records",
  });

  const platformConfig: PlatformConfig = {
    environment: "development",
    logLevel: "warn",
    databaseUrl: platformDatabaseUrl,
    bankName: BANK_NAME,
    bankSignupUrl: "https://bank.example/open-an-account",
    port: 0,
    middlewareBaseUrl: middleware.url,
    whatsappVerifyToken: VERIFY_TOKEN,
    whatsapp: {
      graphApiBaseUrl: whatsapp.url,
      apiToken: GRAPH_TOKEN,
      phoneNumberId: PHONE_NUMBER_ID,
    },
    groq: {
      baseUrl: groq.url,
      apiKey: GROQ_API_KEY,
      intentModel: INTENT_MODEL,
      supportModel: SUPPORT_MODEL,
    },
    attachments: {
      endpoint: objectStore.url,
      bucket: ATTACHMENT_BUCKET,
      region: "us-east-1",
      accessKeyId: PLATFORM_STORE_KEY,
      secretAccessKey: `${PLATFORM_STORE_KEY}-secret`,
    },
  };

  const startPlatform = async (port: number): Promise<RunningService> => {
    const platformApp = await createPlatformApplication({ ...platformConfig, port });
    return startService({
      app: platformApp.app,
      pool: platformApp.pool,
      logger: platformApp.logger,
      service: "platform",
      port,
      databaseAccess: "holds-none-of-them",
    });
  };

  // **The Middleware's own public address**, which is what it hands a Widget to
  // post a sealed surface to. It cannot be known before the ephemeral port is
  // bound, and it is written back rather than composed by the test — a test
  // that pointed the Widget at a URL it built itself would be asserting against
  // its own arithmetic instead of against the address the Middleware gave out.
  // Nothing reads it at boot; every reader asks per request.
  (middlewareConfig as { publicBaseUrl: string }).publicBaseUrl = middleware.url;

  let platform: RunningService = await startPlatform(0);
  let platformRunning = true;

  const seedPool: Pool = createPool(databaseUrl);
  const seedAudit = new AuditRepository(seedPool);
  const bindings = new BindingsRepository(seedPool, seedAudit, clock);
  const pins = new TransactionPinService(seedPool, seedAudit, clock);
  const staffRepository = new StaffRepository(seedPool);
  let staffCount = 0;

  const signInStaff = async (
    role: "support_officer" | "administrator" = "support_officer",
  ): Promise<{ token: string; accountId: string; email: string; password: string }> => {
    staffCount += 1;
    const email = `staff-${staffCount}@bank.example`;
    const password = "a-long-enough-password";
    const account = await staffRepository.createAccount({
      email,
      displayName: `Staff ${staffCount}`,
      password,
      role,
    });

    // MFA is required for an Administrator, so enrol before signing in.
    let totpCode: string | undefined;
    if (role === "administrator") {
      const secret = generateTotpSecret();
      await staffRepository.enrolMfa(account.id, secret);
      totpCode = totp(secret, Date.now());
    }

    const response = await fetch(`${middleware.url}/dashboard/sign-in`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, ...(totpCode ? { totpCode } : {}) }),
    });
    const body = (await response.json()) as { token?: string };
    if (!body.token) throw new Error(`The harness could not sign in as ${role}`);

    return { token: body.token, accountId: account.id, email, password };
  };

  return {
    get platformUrl() {
      return platform.url;
    },
    middlewareUrl: middleware.url,
    flowsPublicKeyPem: flowsKey.publicKeyPem,
    bankOne,
    groq,
    whatsapp,
    bankIdentity,
    connector,
    dispatchedTo,
    objectStore,
    clock,
    query: async <T extends Record<string, unknown>>(sql: string, values: readonly unknown[] = []) =>
      (await seedPool.query<T>(sql, [...values])).rows,
    registerConnector: async (registration) => {
      const token =
        registration.token ?? (await signInStaff("administrator")).token;

      const response = await fetch(`${middleware.url}/dashboard/connectors`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({
          name: registration.name,
          description: registration.description ?? "Does something on the Customer's account.",
          endpoint: registration.endpoint ?? "https://api.bank.example/v1/do",
          gated: registration.gated ?? false,
          parameters: (registration.parameters ?? []).map((parameter) => ({
            required: false,
            description: `The ${parameter.name}`,
            ...parameter,
          })),
          credentialHeader: registration.credentialHeader ?? "authorization",
          credential: registration.credential ?? "Bearer bank-api-secret",
        }),
      });

      if (!response.ok) {
        throw new Error(`The Dashboard refused the Connector: ${await response.text()}`);
      }
      return ((await response.json()) as { connector: Connector }).connector;
    },
    seedBinding: async (channelIdentity, accountNumber) => {
      await bindings.bind(channelIdentity, accountNumber);
    },
    seedPin: async (accountNumber, pin) => {
      await pins.set(accountNumber, pin, { reason: "seeded by a test" });
    },
    signInStaff,

    revokeBindingsFor: async (channelIdentity) => {
      const binding = await bindings.findLiveByChannelIdentity(channelIdentity);
      if (binding) await bindings.revoke(binding.id);
    },
    restartPlatform: async () => {
      const port = new URL(platform.url).port;
      if (platformRunning) await platform.close();
      platform = await startPlatform(Number(port));
      platformRunning = true;
    },
    stopPlatform: async () => {
      if (!platformRunning) return;
      await platform.close();
      platformRunning = false;
    },
    generateSnippet: async () => {
      const { token } = await signInStaff("administrator");
      const response = await fetch(`${middleware.url}/dashboard/snippet`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ label: "test" }),
      });
      if (!response.ok) throw new Error(`The Dashboard declined: HTTP ${response.status}`);
      return (await response.json()) as IssuedSnippet;
    },
    publishToLibrary: async (document) => {
      const { token } = await signInStaff("administrator");
      const headers = { "content-type": "application/json", authorization: `Bearer ${token}` };

      const upload = await fetch(`${middleware.url}/dashboard/library`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          title: document.title,
          ...(document.documentId ? { documentId: document.documentId } : {}),
          versionDate: document.versionDate ?? "2026-03-01",
          mediaType: document.mediaType ?? "text/markdown",
          fileName: document.fileName ?? "policy.md",
          content: Buffer.from(
            typeof document.text === "string" ? Buffer.from(document.text, "utf8") : document.text,
          ).toString("base64"),
        }),
      });
      if (!upload.ok) {
        throw new Error(`The Library refused the upload: ${await upload.text()}`);
      }
      const drafted = (await upload.json()) as PublishedDocument;

      if (document.publish !== false) {
        const published = await fetch(
          `${middleware.url}/dashboard/library/versions/${drafted.versionId}/publish`,
          { method: "POST", headers, body: "{}" },
        );
        if (!published.ok) {
          throw new Error(`The Library refused to publish: ${await published.text()}`);
        }
      }
      return drafted;
    },
    withdrawFromLibrary: async (versionId) => {
      const { token } = await signInStaff("administrator");
      const response = await fetch(
        `${middleware.url}/dashboard/library/versions/${versionId}/withdraw`,
        {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: "{}",
        },
      );
      if (!response.ok) throw new Error(`The Library refused to withdraw: ${await response.text()}`);
    },
    gatedPinFailed: (conversationId, connector) =>
      middlewareApp.app
        .get(HandoffService)
        .gatedPinFailed(
          conversationId,
          connector,
          `The Customer failed the Transaction PIN on ${connector}.`,
        ),
    resolveHandoffs: async () => {
      const { token } = await signInStaff("support_officer");
      const headers = { authorization: `Bearer ${token}` };

      const listed = await fetch(`${middleware.url}/dashboard/inbox`, { headers });
      const { conversations } = (await listed.json()) as {
        conversations: { handoffId: string }[];
      };

      for (const { handoffId } of conversations) {
        await fetch(`${middleware.url}/dashboard/inbox/${handoffId}/claim`, {
          method: "POST",
          headers,
        });
        await fetch(`${middleware.url}/dashboard/inbox/${handoffId}/resolve`, {
          method: "POST",
          headers,
        });
      }
    },
    stop: async () => {
      await seedPool.end();
      if (platformRunning) await platform.close();
      await middleware.close();
      await connector.close();
      await bankIdentity.close();
      await whatsapp.close();
      await groq.close();
      await bankOne.close();
      await objectStore.close();
      await admin.query(`drop database if exists ${databaseName} with (force)`);
      // A role outlives the database it was granted in, so it is dropped here
      // rather than left to accumulate across a test run.
      await admin.query(`drop role if exists ${platformRole}`);
      await admin.query(`drop role if exists avni_middleware_${suffix}`);
      await admin.end();
    },
  };
};

/**
 * Posts a sealed exchange to the Middleware's Flows endpoint, the way a handset
 * does, and opens the answer.
 *
 * Real encryption, real signature, real HTTP. The sealed channel is where the
 * account number, the code and the Transaction PIN all travel, so a test that
 * mocked it would be asserting against the one thing ADR-0007 is about.
 */
export const exchangeFlow = async (
  harness: Harness,
  payload: Readonly<Record<string, unknown>>,
): Promise<{ status: number; screen: string; data: Record<string, unknown> }> => {
  const sealed = sealFlowRequest(harness.flowsPublicKeyPem, payload);
  const raw = JSON.stringify(sealed.body);

  const response = await fetch(`${harness.middlewareUrl}/flows/whatsapp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": signFlowBody(raw, APP_SECRET),
    },
    body: raw,
  });

  if (!response.ok) return { status: response.status, screen: "", data: {} };

  const opened = openFlowResponse(await response.text(), sealed.aesKey, sealed.initialVector) as {
    screen?: string;
    data?: Record<string, unknown>;
  };
  return { status: response.status, screen: opened.screen ?? "", data: opened.data ?? {} };
};

/**
 * The flow token out of the last sealed surface the Customer was sent.
 *
 * Read from what the *Customer received* rather than from the database, because
 * that is the only path a real handset has to it.
 */
export const flowTokenFrom = (harness: Harness): string => {
  const secure = [...harness.whatsapp.sent]
    .reverse()
    .find((message) => message.type === "interactive" && tokenOf(message.raw) !== undefined);

  const token = secure && tokenOf(secure.raw);
  if (!token) throw new Error("The Customer was never sent a sealed surface");
  return token;
};

const tokenOf = (raw: Readonly<Record<string, unknown>>): string | undefined => {
  const parameters = (
    raw["interactive"] as { action?: { parameters?: Record<string, unknown> } } | undefined
  )?.action?.parameters;
  const token = parameters?.["flow_token"];
  return typeof token === "string" ? token : undefined;
};

/**
 * Opens an in-app chat conversation the way the Widget does — through the
 * Platform's versioned edge, carrying only the envelope.
 */
export const openInApp = async (
  harness: Harness,
  identity: string,
  version = "v1",
): Promise<{ status: number; conversationId?: string; outcome: string }> => {
  const response = await fetch(`${harness.platformUrl}/widget/${version}/conversations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identity }),
  });

  if (!response.ok) return { status: response.status, outcome: "http_error" };
  const body = (await response.json()) as { outcome: string; conversationId?: string };
  return { status: response.status, ...body };
};

/**
 * One turn of in-app chat, and **the reply comes back in the same response**.
 *
 * That is the other difference between the two Channels: WhatsApp's answer goes
 * out through the Graph API and is read off the fake, and this one is returned.
 * What is in it is the same `Outbound` verb either way.
 */
export const exchangeInApp = async (
  harness: Harness,
  message: { readonly conversationId: string; readonly said?: string; readonly chose?: string },
  version = "v1",
): Promise<{ status: number; reply?: Record<string, unknown> }> => {
  const response = await fetch(`${harness.platformUrl}/widget/${version}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(message),
  });

  if (!response.ok) return { status: response.status };
  const body = (await response.json()) as { reply?: Record<string, unknown> };
  return { status: response.status, ...body };
};

/**
 * One step of the Widget's sealed surface, posted **straight to the
 * Middleware** the way the Widget posts it.
 *
 * `surfaceUrl` is taken from the reply the Customer received rather than built
 * here, because that address is the thing under test: it is the Middleware
 * naming itself, couriered by a Platform that cannot read it, and a helper that
 * composed its own URL would pass whatever the reply said.
 */
export const exchangeWidgetSurface = async (
  surfaceUrl: string,
  exchange: {
    readonly token?: string | undefined;
    readonly action: string;
    readonly screen?: string;
    readonly data?: Readonly<Record<string, unknown>>;
  },
): Promise<{
  status: number;
  screen: string;
  data: Record<string, unknown>;
  terminal: boolean;
}> => {
  const response = await fetch(surfaceUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: exchange.token,
      action: exchange.action,
      screen: exchange.screen ?? "",
      data: exchange.data ?? {},
    }),
  });

  if (!response.ok) return { status: response.status, screen: "", data: {}, terminal: false };

  const opened = (await response.json()) as {
    screen?: string;
    data?: Record<string, unknown>;
    terminal?: boolean;
  };
  return {
    status: response.status,
    screen: opened.screen ?? "",
    data: opened.data ?? {},
    terminal: opened.terminal === true,
  };
};

/** Pushes a webhook body into the Platform the way Meta would. */
export const postWebhook = async (harness: Harness, body: unknown): Promise<number> => {
  const response = await fetch(`${harness.platformUrl}/channels/whatsapp/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return response.status;
};

/**
 * The webhook returns before the work is done, on purpose — Meta retries
 * anything that is not a prompt 200. Tests wait on the observable effect.
 */
export const waitFor = async <T>(
  read: () => T | undefined | Promise<T | undefined>,
  what: string,
  timeoutMs = 5000,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

/** Waits until the Customer has received `count` messages, then returns them. */
export const waitForReplies = async (
  harness: Harness,
  count = 1,
): Promise<readonly string[]> => {
  await waitFor(
    () => (harness.whatsapp.sent.length >= count ? true : undefined),
    `${count} reply(ies) to the Customer`,
  );
  return harness.whatsapp.transcript();
};

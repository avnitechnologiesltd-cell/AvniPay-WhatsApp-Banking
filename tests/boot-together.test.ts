import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { MiddlewareConfig, PlatformConfig } from "@avni/config";
import {
  DatabasePrivilegeError,
  PendingMigrationsError,
  applyMigrations,
  applyRoleGrants,
  createPool,
  readMigrations,
  type Pool,
} from "@avni/db";
import { writeFlowsKeypair, TEST_ENCRYPTION_KEY } from "@avni/fakes";
import { createMiddlewareApplication } from "@avni/middleware";
import { createPlatformApplication } from "@avni/platform";
import { startService, type RunningService } from "@avni/service";

/**
 * The harness this ticket exists to provide: Platform, Middleware and Postgres
 * booted together, with every external base URL pointed anywhere.
 *
 * The four systems we do not own are the only seam. Nothing here fakes BankOne,
 * Groq, WhatsApp or the Bank's identity API — each of those arrives with the
 * slice that first needs one. What is proved here is that when they do, there
 * is somewhere to point them.
 */

/** One throwaway Flows keypair for the file; never the Bank's. */
const flowsKey = writeFlowsKeypair();

const ADMIN_URL =
  process.env["TEST_DATABASE_URL"] ?? "postgres://avni:avni@localhost:5432/avni";

const withDatabase = (connectionString: string, name: string): string => {
  const url = new URL(connectionString);
  url.pathname = `/${name}`;
  return url.toString();
};

/** Stands in for whichever external service a later slice will fake properly. */
const arbitraryAddress = async (): Promise<{ url: string; close: () => Promise<void> }> => {
  const server: Server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

let admin: Pool;
let databaseName: string;
/** The owning credential — `DATABASE_URL`, and the migration step's alone. */
let databaseUrl: string;
/**
 * What the two deployables actually connect as, once the release step has made
 * the roles. The Middleware reads and writes every table; the Platform may
 * connect and nothing else. Booting them under these rather than under the
 * owner is what makes this file say the bundle works, rather than that it would
 * work if the grants happened to be generous.
 */
let middlewareRole: string;
let platformRole: string;
let middlewareDatabaseUrl: string;
let platformDatabaseUrl: string;
let outside: { url: string; close: () => Promise<void> };
const running: RunningService[] = [];

const ROLE_PASSWORD = "boot-together-password";

const asRole = (role: string): string => {
  const url = new URL(withDatabase(ADMIN_URL, databaseName));
  url.username = role;
  url.password = ROLE_PASSWORD;
  return url.toString();
};

const middlewareConfig = (): MiddlewareConfig => ({
  environment: "development",
  logLevel: "warn",
  databaseUrl: middlewareDatabaseUrl,
  port: 0,
  publicBaseUrl: outside.url,
  platformPublicBaseUrl: outside.url,
  credentialEncryptionKey: TEST_ENCRYPTION_KEY,
  bankName: "Example MFB",
  bankOne: {
    webApiBaseUrl: outside.url,
    thirdPartyApiBaseUrl: outside.url,
    apiKey: "test-auth-token",
    institutionCode: "test-institution",
    bankCode: "test-bank",
    productCode: "test-product",
    officerCode: "test-officer",
  },
  whatsapp: {
    graphApiBaseUrl: outside.url,
    apiToken: "test-graph-token",
    verifyToken: "test-verify-token",
    phoneNumberId: "test-phone-number-id",
    appSecret: "test-app-secret",
    flows: {
      privateKeyPath: flowsKey.keyPath,
      passphrase: flowsKey.passphrase,
      sendMoneyFlowId: "test-send-money-flow",
      setPinFlowId: "test-set-pin-flow",
      enrollmentFlowId: "test-enrollment-flow",
    },
    reopenTemplate: { name: "support_update_available", language: "en" },
  },
  bankIdentity: { baseUrl: outside.url, apiKey: "test-identity-key" },
  enrollment: {
    nubanBankCode: "030",
    decoySecret: "test-decoy-secret-long-enough",
    bindingDormancyDays: 90,
  },
  auditRetentionDays: 0,
  handoff: { claimIdleMinutes: 30 },
  library: { retrievalBudgetTokens: 8_000 },
  attachments: {
    endpoint: outside.url,
    bucket: "avni-attachments",
    region: "us-east-1",
    accessKeyId: "middleware-reads-only",
    secretAccessKey: "middleware-reads-only-secret",
  },
});

const platformConfig = (middlewareUrl: string): PlatformConfig => ({
  environment: "development",
  logLevel: "warn",
  databaseUrl: platformDatabaseUrl,
  bankName: "Example MFB",
  bankSignupUrl: "https://bank.example/open-an-account",
  port: 0,
  middlewareBaseUrl: middlewareUrl,
  whatsappVerifyToken: "test-verify-token",
  whatsapp: {
    graphApiBaseUrl: outside.url,
    apiToken: "test-graph-token",
    phoneNumberId: "test-phone-number-id",
  },
  groq: {
    baseUrl: outside.url,
    apiKey: "test-groq-key",
    intentModel: "test-intent-model",
    supportModel: "test-support-model",
  },
  attachments: {
    endpoint: outside.url,
    bucket: "avni-attachments",
    region: "us-east-1",
    accessKeyId: "platform-writes-only",
    secretAccessKey: "platform-writes-only-secret",
  },
});

const startMiddleware = async (config = middlewareConfig()): Promise<RunningService> => {
  const { app, pool, logger } = await createMiddlewareApplication(config);
  const service = await startService({
    app,
    pool,
    logger,
    service: "middleware",
    port: config.port,
    databaseAccess: "holds-the-security-records",
  });
  running.push(service);
  return service;
};

const startPlatform = async (
  middlewareUrl: string,
  config = platformConfig(middlewareUrl),
): Promise<RunningService> => {
  const { app, pool, logger } = await createPlatformApplication(config);
  const service = await startService({
    app,
    pool,
    logger,
    service: "platform",
    port: config.port,
    databaseAccess: "holds-none-of-them",
  });
  running.push(service);
  return service;
};

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await admin.query("select 1");
});

afterAll(async () => {
  await admin.end();
});

beforeEach(async () => {
  outside = await arbitraryAddress();
  const suffix = randomBytes(6).toString("hex");
  databaseName = `avni_boot_${suffix}`;
  middlewareRole = `avni_middleware_${suffix}`;
  platformRole = `avni_platform_${suffix}`;
  await admin.query(`create database ${databaseName}`);
  databaseUrl = withDatabase(ADMIN_URL, databaseName);
  middlewareDatabaseUrl = asRole(middlewareRole);
  platformDatabaseUrl = asRole(platformRole);
});

afterEach(async () => {
  while (running.length > 0) await running.pop()?.close();
  await outside.close();
  await admin.query(`drop database if exists ${databaseName} with (force)`);
  await admin.query(`drop role if exists ${middlewareRole}`);
  await admin.query(`drop role if exists ${platformRole}`);
});

/**
 * The explicit release step, run the way an operator runs it: the migrations,
 * and then the grants that decide which login may read what. Both, in that
 * order, because that is what `docker compose run --rm migrate` does — and
 * every deployable this file boots afterwards connects as one of the two roles
 * it creates rather than as the owner.
 */
const runMigrationStep = async (): Promise<void> => {
  const pool = createPool(databaseUrl);
  try {
    await applyMigrations(pool, readMigrations());
    await applyRoleGrants(pool, {
      middleware: { role: middlewareRole, password: ROLE_PASSWORD },
      platform: { role: platformRole, password: ROLE_PASSWORD },
    });
  } finally {
    await pool.end();
  }
};

/**
 * Before the release step there are no roles yet, so the two tests about an
 * un-migrated database are the only ones that connect as the owner. Everything
 * after them is the deployment as it actually runs.
 */
const beforeTheReleaseStep = <T extends { databaseUrl: string }>(config: T): T => ({
  ...config,
  databaseUrl,
});

describe("booting the Platform, the Middleware and Postgres together", () => {
  it("refuses to serve against a database the migration step has not been run on", async () => {
    await expect(startMiddleware(beforeTheReleaseStep(middlewareConfig()))).rejects.toThrow(
      PendingMigrationsError,
    );
    await expect(
      startPlatform("http://127.0.0.1:1", beforeTheReleaseStep(platformConfig("http://127.0.0.1:1"))),
    ).rejects.toThrow(PendingMigrationsError);
  });

  it("refuses to serve as a login that can read the Middleware's tables", async () => {
    // **The check the migration step cannot make.** That step refuses three
    // database URLs naming one login — but it only runs when somebody runs it,
    // and editing `.env` to point the Platform at the Middleware's role and
    // running `docker compose up -d` against an already-migrated database never
    // reaches it. So the Platform asks Postgres what it may actually read,
    // every time it boots, and refuses to serve if the answer is wider than
    // ADR-0006 allows.
    await runMigrationStep();

    const asTheMiddleware = {
      ...platformConfig("http://127.0.0.1:1"),
      databaseUrl: middlewareDatabaseUrl,
    };

    await expect(startPlatform("http://127.0.0.1:1", asTheMiddleware)).rejects.toThrow(
      DatabasePrivilegeError,
    );
    // And it names what it could reach, rather than only that it could.
    await expect(startPlatform("http://127.0.0.1:1", asTheMiddleware)).rejects.toThrow(/bindings/);
  });

  it("refuses to serve under a bank code that belongs to another bank", async () => {
    await runMigrationStep();

    // `090110` is VFD Microfinance Bank, and it is the value the vendored API
    // guide uses as its example for `BANK_CODE` — which is how it reached a
    // real `.env`. Left alone it is silent in every environment that can be
    // tested: same-bank name enquiry asks VFD who holds an account, and staging
    // cannot show it because staging's name enquiry is stubbed.
    const wrong = {
      ...middlewareConfig(),
      bankOne: { ...middlewareConfig().bankOne, bankCode: "090110" },
    };

    await expect(startMiddleware(wrong)).rejects.toThrow(/VFD/);
    // And it stops before anything is built, rather than after it is serving.
    await expect(startMiddleware(wrong)).rejects.toThrow(/BANK_CODE/);
  });

  it("does not migrate the database on the way to failing", async () => {
    await expect(startMiddleware(beforeTheReleaseStep(middlewareConfig()))).rejects.toThrow();

    const pool = createPool(databaseUrl);
    try {
      const { rows } = await pool.query<{ present: boolean }>(
        "select to_regclass('schema_migrations') is not null as present",
      );
      expect(rows[0]?.present).toBe(false);
    } finally {
      await pool.end();
    }
  });

  it("brings both deployables up once migrations have been run", async () => {
    await runMigrationStep();

    const middleware = await startMiddleware();
    const platform = await startPlatform(middleware.url);

    for (const [service, base] of [
      ["middleware", middleware.url],
      ["platform", platform.url],
    ] as const) {
      const response = await fetch(`${base}/health`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: "ok", service });
    }
  });

  it("reports itself ready only once Postgres answers", async () => {
    await runMigrationStep();
    const middleware = await startMiddleware();

    const response = await fetch(`${middleware.url}/health/ready`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ready",
      service: "middleware",
      checks: { postgres: "ok" },
    });
  });

  it("points every external base URL at an arbitrary address", async () => {
    await runMigrationStep();
    const config = middlewareConfig();

    // Every one of these is somewhere a fake will be injected by a later slice:
    // BankOne's WebAPI and Third Party service, the WhatsApp Graph API, and the
    // Bank's identity API. None is a constant, so none needs a new seam.
    expect([
      config.bankOne.webApiBaseUrl,
      config.bankOne.thirdPartyApiBaseUrl,
      config.whatsapp.graphApiBaseUrl,
      config.bankIdentity.baseUrl,
    ]).toEqual([outside.url, outside.url, outside.url, outside.url]);

    const middleware = await startMiddleware(config);
    const platform = await startPlatform(middleware.url);

    expect(platformConfig(middleware.url).groq.baseUrl).toBe(outside.url);
    expect((await fetch(`${platform.url}/health`)).status).toBe(200);
    expect((await fetch(`${outside.url}/anything`)).status).toBe(200);
  });

  it("shares one Postgres and starts nothing else", async () => {
    await runMigrationStep();
    const middleware = await startMiddleware();
    const platform = await startPlatform(middleware.url);

    const [middlewareReady, platformReady] = await Promise.all([
      fetch(`${middleware.url}/health/ready`).then((r) => r.json() as Promise<unknown>),
      fetch(`${platform.url}/health/ready`).then((r) => r.json() as Promise<unknown>),
    ]);

    // One datastore. If a second ever appears it shows up here as a second check.
    expect(Object.keys((middlewareReady as { checks: object }).checks)).toEqual(["postgres"]);
    expect(Object.keys((platformReady as { checks: object }).checks)).toEqual(["postgres"]);
  });

  it("closes its database connections when the deployable stops", async () => {
    await runMigrationStep();
    const middleware = await startMiddleware();
    await middleware.close();
    running.pop();

    const { rows } = await admin.query<{ count: string }>(
      "select count(*)::text as count from pg_stat_activity where datname = $1",
      [databaseName],
    );
    expect(Number(rows[0]?.count)).toBe(0);
  });
});

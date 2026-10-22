import { randomBytes } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { MiddlewareConfig } from "@avni/config";
import { applyMigrations, createPool, readMigrations, type Pool } from "@avni/db";
import { startFakeBankOne, writeFlowsKeypair, type FakeBankOne, TEST_ENCRYPTION_KEY } from "@avni/fakes";
import { startService, systemClock, type RunningService } from "@avni/service";

import { createMiddlewareApplication } from "../index";
import { AuditRepository } from "../audit/audit.repository";
import { BindingsRepository } from "../identity/bindings.repository";

const bindingsRepository = (pool: Pool): BindingsRepository =>
  new BindingsRepository(pool, new AuditRepository(pool), systemClock);

/**
 * The Middleware's inward face, driven over real HTTP against real Postgres and
 * the BankOne fake. Nothing below the four systems we do not own is mocked.
 */

/** One throwaway Flows keypair for the file; never the Bank's. */
const flowsKey = writeFlowsKeypair();

const ADMIN_URL = process.env["TEST_DATABASE_URL"] ?? "postgres://avni:avni@localhost:5432/avni";
const AUTH_TOKEN = "test-auth-token";
const INSTITUTION_CODE = "test-institution";
const ACCOUNT = "0123456789";
const CUSTOMER_NUMBER = "2348012345678";

let admin: Pool;
let databaseName: string;
let databaseUrl: string;
let bankOne: FakeBankOne;
let middleware: RunningService;
let pool: Pool;

const withDatabase = (connectionString: string, name: string): string => {
  const url = new URL(connectionString);
  url.pathname = `/${name}`;
  return url.toString();
};

const configFor = (): MiddlewareConfig => ({
  environment: "development",
  logLevel: "warn",
  databaseUrl,
  port: 0,
  publicBaseUrl: bankOne.url,
  platformPublicBaseUrl: bankOne.url,
  credentialEncryptionKey: TEST_ENCRYPTION_KEY,
  bankName: "Example MFB",
  bankOne: {
    webApiBaseUrl: bankOne.url,
    thirdPartyApiBaseUrl: bankOne.url,
    apiKey: AUTH_TOKEN,
    institutionCode: INSTITUTION_CODE,
    bankCode: "test-bank",
    productCode: "test-product",
    officerCode: "test-officer",
  },
  whatsapp: {
    graphApiBaseUrl: bankOne.url,
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
  bankIdentity: { baseUrl: bankOne.url, apiKey: "test-identity-key" },
  enrollment: {
    nubanBankCode: "030",
    decoySecret: "test-decoy-secret-long-enough",
    bindingDormancyDays: 90,
  },
  auditRetentionDays: 0,
  handoff: { claimIdleMinutes: 30 },
  library: { retrievalBudgetTokens: 8_000 },
  attachments: {
    endpoint: "http://127.0.0.1:1",
    bucket: "avni-attachments",
    region: "us-east-1",
    accessKeyId: "unused",
    secretAccessKey: "unused",
  },
});

const post = async (path: string, body: unknown): Promise<{ status: number; body: unknown }> => {
  const response = await fetch(`${middleware.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as unknown };
};

const openConversation = async (
  channelIdentity = CUSTOMER_NUMBER,
): Promise<{ conversationId: string; identified: boolean }> => {
  const { body } = await post("/platform/conversations", {
    channel: "whatsapp",
    channelIdentity,
  });
  return body as { conversationId: string; identified: boolean };
};

/**
 * Seeds a Binding without walking the Flow. Enrollment is driven end to end in
 * `tests/enrollment.test.ts`; this file is about the Middleware's inward face.
 */
const seedBinding = async (accountNumber = ACCOUNT, channelIdentity = CUSTOMER_NUMBER) =>
  (await bindingsRepository(pool).bind(channelIdentity, accountNumber)).created;

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await admin.query("select 1");
});

afterAll(async () => {
  await admin.end();
});

beforeEach(async () => {
  databaseName = `avni_mw_${randomBytes(6).toString("hex")}`;
  await admin.query(`create database ${databaseName}`);
  databaseUrl = withDatabase(ADMIN_URL, databaseName);

  const migrator = createPool(databaseUrl);
  await applyMigrations(migrator, readMigrations());
  await migrator.end();

  bankOne = await startFakeBankOne({
    authToken: AUTH_TOKEN,
    institutionCode: INSTITUTION_CODE,
    accounts: [{ accountNumber: ACCOUNT, availableBalance: 1_000_000 }],
  });

  pool = createPool(databaseUrl);
  const application = await createMiddlewareApplication(configFor());
  middleware = await startService({
    app: application.app,
    pool: application.pool,
    logger: application.logger,
    service: "middleware",
    port: 0,
    databaseAccess: "holds-the-security-records",
  });
});

afterEach(async () => {
  await middleware?.close();
  await pool?.end();
  await bankOne?.close();
  await admin.query(`drop database if exists ${databaseName} with (force)`);
});

describe("opening a conversation", () => {
  it("issues an unguessable id the Platform did not mint", async () => {
    await seedBinding();

    const first = await openConversation();
    const second = await openConversation();

    expect(first.conversationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(first.conversationId).not.toBe(second.conversationId);
  });

  it("answers a bit about identity and never the account number", async () => {
    await seedBinding();

    const { body } = await post("/platform/conversations", {
      channel: "whatsapp",
      channelIdentity: CUSTOMER_NUMBER,
    });

    expect(body).toEqual({ conversationId: expect.any(String), identified: true });
    expect(JSON.stringify(body)).not.toContain(ACCOUNT);
  });

  it("opens for somebody with no Binding, who is enrolling rather than anonymous", async () => {
    const opened = await openConversation("2348099999999");

    expect(opened.identified).toBe(false);
    expect(opened.conversationId).toEqual(expect.any(String));
  });

  it("refuses a request that names no channel identity", async () => {
    expect((await post("/platform/conversations", { channel: "whatsapp" })).status).toBe(400);
  });
});

describe("submitting an Intent", () => {
  it("answers a balance enquiry with naira, from the Binding's account", async () => {
    await seedBinding();
    const { conversationId } = await openConversation();

    const { body } = await post(`/platform/conversations/${conversationId}/intents`, {
      intent: { kind: "check_balance" },
    });

    expect(body).toEqual({
      kind: "balance",
      availableBalance: 1_000_000,
      ledgerBalance: 1_000_000,
      withdrawableBalance: 1_000_000,
    });
  });

  it("resolves the account itself and takes none from the Platform", async () => {
    await seedBinding();
    const { conversationId } = await openConversation();

    // An Intent naming somebody else's account is not a smaller request — it is
    // not an Intent at all, because the union has no field to carry one.
    const { status } = await post(`/platform/conversations/${conversationId}/intents`, {
      intent: { kind: "check_balance", accountNumber: "9999999999" },
    });

    expect(status).toBe(400);
    expect(bankOne.requests).toHaveLength(0);
  });

  it("reads the account from the Binding rather than from the conversation", async () => {
    await seedBinding();
    const { conversationId } = await openConversation();

    await post(`/platform/conversations/${conversationId}/intents`, {
      intent: { kind: "check_balance" },
    });

    expect(bankOne.requests[0]?.query["accountNumber"]).toBe(ACCOUNT);
  });

  it("refuses a conversation id the Platform invented", async () => {
    await seedBinding();

    const invented = await post(
      "/platform/conversations/00000000-0000-4000-8000-000000000000/intents",
      { intent: { kind: "check_balance" } },
    );
    const malformed = await post("/platform/conversations/not-a-uuid/intents", {
      intent: { kind: "check_balance" },
    });

    expect(invented.body).toEqual({ kind: "not_identified" });
    expect(malformed.body).toEqual({ kind: "not_identified" });
  });

  it("answers not_identified for a conversation with no Binding", async () => {
    const { conversationId } = await openConversation("2348099999999");

    const { body } = await post(`/platform/conversations/${conversationId}/intents`, {
      intent: { kind: "check_balance" },
    });

    expect(body).toEqual({ kind: "not_identified" });
    expect(bankOne.requests).toHaveLength(0);
  });

  it("stops answering the moment a Binding is revoked", async () => {
    const binding = await seedBinding();
    const { conversationId } = await openConversation();
    await bindingsRepository(pool).revoke(binding.id);

    const { body } = await post(`/platform/conversations/${conversationId}/intents`, {
      intent: { kind: "check_balance" },
    });

    expect(body).toEqual({ kind: "not_identified" });
  });

  it("answers not_available for transaction history on an unentitled token", async () => {
    // The first deployment, today: `GetTransactions` answers HTTP 200 and a message, and
    // `GetDailyAccountStatement` 404s, so there is nothing else to read
    // (Appendix A.1). Not an error, and not an empty list.
    await seedBinding();
    const { conversationId } = await openConversation();
    bankOne.setEntitled("GetTransactions", false);

    const { body } = await post(`/platform/conversations/${conversationId}/intents`, {
      intent: { kind: "list_transactions", period: "last_month" },
    });

    expect(body).toEqual({ kind: "not_available" });
  });

  it("answers the rows once the entitlement arrives", async () => {
    await seedBinding();
    const { conversationId } = await openConversation();
    bankOne.setAccount({
      accountNumber: ACCOUNT,
      availableBalance: 1_000_000,
      transactions: [
        {
          amount: 1_000_000,
          direction: "credit",
          occurredAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
          narration: "Salary",
        },
      ],
    });

    const { body } = await post(`/platform/conversations/${conversationId}/intents`, {
      intent: { kind: "list_transactions", period: "last_month" },
    });

    expect(body).toMatchObject({
      kind: "transactions",
      period: "last_month",
      rows: [{ amount: 1_000_000, direction: "credit", narration: "Salary" }],
    });
  });

  it("refuses a list_transactions Intent that names an account", async () => {
    // The Intent carries the period and nothing else; the Middleware resolves
    // the account from the Binding. `.strict()` is what makes that a failure to
    // parse rather than a field silently carried.
    await seedBinding();
    const { conversationId } = await openConversation();

    const { status } = await post(`/platform/conversations/${conversationId}/intents`, {
      intent: { kind: "list_transactions", period: "last_month", accountNumber: "9999999999" },
    });

    expect(status).toBe(400);
  });

  it("refuses an Intent kind that is not in the union", async () => {
    await seedBinding();
    const { conversationId } = await openConversation();

    const { status } = await post(`/platform/conversations/${conversationId}/intents`, {
      intent: { kind: "close_my_account" },
    });

    expect(status).toBe(400);
  });

  it("tells the Platform nothing about why a read failed", async () => {
    await seedBinding("1111111111");
    const { conversationId } = await openConversation();

    const { body } = await post(`/platform/conversations/${conversationId}/intents`, {
      intent: { kind: "check_balance" },
    });

    // BankOne's own words belong in the log and the audit table, not in the
    // layer that reads Customer text.
    expect(body).toEqual({ kind: "failed" });
  });
});

describe("the Binding", () => {
  it("allows one live Binding per channel identity", async () => {
    await seedBinding("0123456789");
    await seedBinding("2222222222");

    const { rows } = await pool.query<{ count: string }>(
      "select count(*)::text as count from bindings where channel_identity = $1 and revoked_at is null",
      [CUSTOMER_NUMBER],
    );
    expect(Number(rows[0]?.count)).toBe(1);
  });

  it("revokes the old Binding when an account is enrolled on a new number", async () => {
    const first = await seedBinding(ACCOUNT, CUSTOMER_NUMBER);
    await seedBinding(ACCOUNT, "2348055555555");

    const repository = bindingsRepository(pool);
    expect((await repository.findById(first.id))?.revokedAt).not.toBeNull();
    expect((await repository.findLiveByChannelIdentity(CUSTOMER_NUMBER))).toBeUndefined();
    expect((await repository.findLiveByChannelIdentity("2348055555555"))?.accountNumber).toBe(
      ACCOUNT,
    );
  });

  it("refuses an account number that is not a NUBAN", async () => {
    await expect(seedBinding("123")).rejects.toThrow();
  });
});

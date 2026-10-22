import { randomBytes } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { MiddlewareConfig } from "@avni/config";
import { applyMigrations, createPool, readMigrations, type Pool } from "@avni/db";
import { startFakeBankOne, writeFlowsKeypair, type FakeBankOne, TEST_ENCRYPTION_KEY } from "@avni/fakes";
import { startService, type RunningService } from "@avni/service";

import { AuditRepository } from "../audit/audit.repository";
import { createMiddlewareApplication } from "../index";
import { StaffRepository } from "../staff/staff.repository";
import { generateTotpSecret, totp } from "../staff/totp";

/** One throwaway Flows keypair for the file; never the Bank's. */
const flowsKey = writeFlowsKeypair();

const ADMIN_URL = process.env["TEST_DATABASE_URL"] ?? "postgres://avni:avni@localhost:5432/avni";
const PASSWORD = "a-long-enough-password";

let admin: Pool;
let databaseName: string;
let databaseUrl: string;
let bankOne: FakeBankOne;
let middleware: RunningService;
let pool: Pool;
let staff: StaffRepository;

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
    apiKey: "test-auth-token",
    institutionCode: "test-institution",
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

const request = async (
  method: "GET" | "POST",
  path: string,
  options: { token?: string; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> => {
  const response = await fetch(`${middleware.url}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  return { status: response.status, body: (await response.json().catch(() => undefined)) as unknown };
};

/** Signs somebody in and returns their bearer token. */
const signIn = async (email: string, totpCode?: string): Promise<string> => {
  const { body } = await request("POST", "/dashboard/sign-in", {
    body: { email, password: PASSWORD, ...(totpCode ? { totpCode } : {}) },
  });
  return (body as { token: string }).token;
};

const anOfficer = async () => {
  await staff.createAccount({
    email: "ada@bank.example",
    displayName: "Ada",
    password: PASSWORD,
    role: "support_officer",
  });
  return signIn("ada@bank.example");
};

const anAdministrator = async () => {
  const account = await staff.createAccount({
    email: "grace@bank.example",
    displayName: "Grace",
    password: PASSWORD,
    role: "administrator",
  });
  const secret = generateTotpSecret();
  await staff.enrolMfa(account.id, secret);
  return signIn("grace@bank.example", totp(secret, Date.now()));
};

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await admin.query("select 1");
});

afterAll(async () => {
  await admin.end();
});

beforeEach(async () => {
  databaseName = `avni_dash_${randomBytes(6).toString("hex")}`;
  await admin.query(`create database ${databaseName}`);
  databaseUrl = withDatabase(ADMIN_URL, databaseName);

  const migrator = createPool(databaseUrl);
  await applyMigrations(migrator, readMigrations());
  await migrator.end();

  bankOne = await startFakeBankOne({ authToken: "test-auth-token", institutionCode: "test-institution" });
  pool = createPool(databaseUrl);
  staff = new StaffRepository(pool);

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

describe("a fresh deployment", () => {
  it("has no account to sign in with", async () => {
    // No default `admin`, which is what the prior art created on first boot.
    expect(await staff.countAccounts()).toBe(0);

    const { status } = await request("POST", "/dashboard/sign-in", {
      body: { email: "admin", password: "admin" },
    });

    expect(status).toBe(401);
  });
});

describe("signing in", () => {
  it("lets a Support Officer in and hands back a token", async () => {
    await staff.createAccount({
      email: "ada@bank.example",
      displayName: "Ada",
      password: PASSWORD,
      role: "support_officer",
    });

    const { status, body } = await request("POST", "/dashboard/sign-in", {
      body: { email: "ada@bank.example", password: PASSWORD },
    });

    expect(status).toBe(201);
    expect(body).toMatchObject({ token: expect.any(String), account: { displayName: "Ada" } });
  });

  it("asks an Administrator for a code before letting them in", async () => {
    const account = await staff.createAccount({
      email: "grace@bank.example",
      displayName: "Grace",
      password: PASSWORD,
      role: "administrator",
    });
    await staff.enrolMfa(account.id, generateTotpSecret());

    const { body } = await request("POST", "/dashboard/sign-in", {
      body: { email: "grace@bank.example", password: PASSWORD },
    });

    expect(body).toEqual({ mfaRequired: true, enrolled: true });
    expect(body).not.toHaveProperty("token");
  });

  it("answers a wrong password and an unknown email identically", async () => {
    await staff.createAccount({
      email: "ada@bank.example",
      displayName: "Ada",
      password: PASSWORD,
      role: "support_officer",
    });

    const wrong = await request("POST", "/dashboard/sign-in", {
      body: { email: "ada@bank.example", password: "wrong-password" },
    });
    const unknown = await request("POST", "/dashboard/sign-in", {
      body: { email: "nobody@bank.example", password: PASSWORD },
    });

    expect(wrong.status).toBe(401);
    expect(unknown).toEqual(wrong);
  });

  it("never puts a password hash on the wire", async () => {
    await staff.createAccount({
      email: "ada@bank.example",
      displayName: "Ada",
      password: PASSWORD,
      role: "support_officer",
    });

    const { body } = await request("POST", "/dashboard/sign-in", {
      body: { email: "ada@bank.example", password: PASSWORD },
    });

    expect(JSON.stringify(body)).not.toContain("$argon2id$");
    expect(JSON.stringify(body)).not.toContain(PASSWORD);
  });
});

describe("the session", () => {
  it("is required for every surface", async () => {
    for (const path of ["/dashboard/me", "/dashboard/audit"]) {
      expect((await request("GET", path)).status).toBe(401);
      expect((await request("GET", path, { token: "made-up" })).status).toBe(401);
    }
  });

  it("is refused immediately once signed out, without a redeploy", async () => {
    const token = await anOfficer();
    expect((await request("GET", "/dashboard/me", { token })).status).toBe(200);

    await request("POST", "/dashboard/sign-out", { token });

    expect((await request("GET", "/dashboard/me", { token })).status).toBe(401);
  });

  it("is refused immediately once the account is disabled", async () => {
    const token = await anOfficer();
    const account = await staff.findByEmail("ada@bank.example");
    await staff.setDisabled(account?.id ?? "", true);

    expect((await request("GET", "/dashboard/me", { token })).status).toBe(401);
  });
});

describe("the two roles, in both directions", () => {
  it("lets a Support Officer read the audit log", async () => {
    const token = await anOfficer();

    expect((await request("GET", "/dashboard/audit", { token })).status).toBe(200);
  });

  it("lets an Administrator read it too, because the roles nest", async () => {
    const token = await anAdministrator();

    expect((await request("GET", "/dashboard/audit", { token })).status).toBe(200);
  });
});

describe("what only an Administrator may do", () => {
  it("refuses a Support Officer the Officer list", async () => {
    // The role table gives a Support Officer no access to this surface at all —
    // not read-only access. Who else can get in is not their business.
    const token = await anOfficer();

    expect((await request("GET", "/dashboard/officers", { token })).status).toBe(403);
  });

  it("lets an Administrator read it", async () => {
    const token = await anAdministrator();

    const { status, body } = await request("GET", "/dashboard/officers", { token });

    expect(status).toBe(200);
    expect((body as { officers: unknown[] }).officers).toHaveLength(1);
  });

  it("refuses a Support Officer creating an account", async () => {
    // The escalation this rules out: an Officer making themselves an
    // Administrator.
    const token = await anOfficer();

    const { status } = await request("POST", "/dashboard/officers", {
      token,
      body: {
        email: "mallory@bank.example",
        displayName: "Mallory",
        password: PASSWORD,
        role: "administrator",
      },
    });

    expect(status).toBe(403);
    expect(await staff.countAccounts()).toBe(1);
  });

  it("lets an Administrator create one", async () => {
    const token = await anAdministrator();

    const { status, body } = await request("POST", "/dashboard/officers", {
      token,
      body: {
        email: "ada@bank.example",
        displayName: "Ada",
        password: PASSWORD,
        role: "support_officer",
      },
    });

    expect(status).toBe(201);
    expect(body).toMatchObject({ email: "ada@bank.example", role: "support_officer" });
    expect(await staff.countAccounts()).toBe(2);
  });

  it("refuses a password too short to be worth hashing", async () => {
    const token = await anAdministrator();

    const { status } = await request("POST", "/dashboard/officers", {
      token,
      body: { email: "ada@bank.example", displayName: "Ada", password: "short", role: "support_officer" },
    });

    expect(status).toBe(400);
    expect(await staff.countAccounts()).toBe(1);
  });

  it("records a refusal as firmly as it records success", async () => {
    // A refused attempt is exactly what an insider-threat investigation wants,
    // and it cannot be reconstructed afterwards.
    const token = await anOfficer();
    await request("POST", "/dashboard/officers", {
      token,
      body: {
        email: "mallory@bank.example",
        displayName: "Mallory",
        password: PASSWORD,
        role: "administrator",
      },
    });

    const entries = await new AuditRepository(pool).read({ action: "officers.write" });
    expect(entries[0]).toMatchObject({ outcome: "refused", actorKind: "officer" });
    expect(entries[0]?.detail["requestedRole"]).toBe("administrator");
  });

  it("never records the password of an account being created", async () => {
    const token = await anAdministrator();
    await request("POST", "/dashboard/officers", {
      token,
      body: { email: "ada@bank.example", displayName: "Ada", password: PASSWORD, role: "support_officer" },
    });

    expect(JSON.stringify(await new AuditRepository(pool).read())).not.toContain(PASSWORD);
  });
});

describe("every action writes an audit row, reads included", () => {
  it("records a read of the audit log itself", async () => {
    const token = await anOfficer();

    await request("GET", "/dashboard/audit", { token });

    const entries = await new AuditRepository(pool).read({ action: "audit.read" });
    expect(entries[0]).toMatchObject({ actorKind: "officer", outcome: "succeeded" });
    expect(entries[0]?.actorId).toBeTruthy();
  });

  it("records which Customer was looked for, not only that somebody looked", async () => {
    // "Who went looking for this account" is where an investigation starts.
    const token = await anOfficer();

    await request("GET", "/dashboard/audit?accountNumber=0123456789", { token });

    const entries = await new AuditRepository(pool).read({ action: "audit.read" });
    const filters = entries[0]?.detail["filters"] as Record<string, unknown>;
    expect(filters["accountNumber"]).toBe("0123456789");
  });

  it("names an Administrator as an administrator rather than an officer", async () => {
    const token = await anAdministrator();

    await request("GET", "/dashboard/audit", { token });

    const entries = await new AuditRepository(pool).read({ action: "audit.read" });
    expect(entries[0]?.actorKind).toBe("administrator");
  });

  it("records a sign-in and a sign-out", async () => {
    const token = await anOfficer();
    await request("POST", "/dashboard/sign-out", { token });

    const audit = new AuditRepository(pool);
    expect(await audit.read({ action: "staff.sign_in" })).toHaveLength(1);
    expect(await audit.read({ action: "staff.signed_out" })).toHaveLength(1);
  });

  it("records a refused sign-in, which is what probing looks like", async () => {
    await request("POST", "/dashboard/sign-in", {
      body: { email: "nobody@bank.example", password: PASSWORD },
    });

    const entries = await new AuditRepository(pool).read({ action: "staff.sign_in" });
    expect(entries[0]).toMatchObject({ outcome: "refused" });
  });
});

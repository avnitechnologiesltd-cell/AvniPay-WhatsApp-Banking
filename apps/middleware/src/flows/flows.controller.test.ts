import { generateKeyPairSync, randomBytes } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { MiddlewareConfig } from "@avni/config";
import { applyMigrations, createPool, readMigrations, type Pool } from "@avni/db";
import {
  openFlowResponse,
  sealFlowRequest,
  signFlowBody,
  startFakeBankOne,
  writeFlowsKeypair,
  type FakeBankOne,
  TEST_ENCRYPTION_KEY,
} from "@avni/fakes";
import { startService, type RunningService } from "@avni/service";

import { AuditRepository } from "../audit/audit.repository";
import { createMiddlewareApplication } from "../index";
import { flowSignatureNotice, signatureFailure } from "./signature";

/**
 * The endpoint, driven over real HTTP the way WhatsApp drives it: a signed
 * request whose body is sealed under a key we can only open with the private
 * half loaded from a mounted path.
 */

const ADMIN_URL = process.env["TEST_DATABASE_URL"] ?? "postgres://avni:avni@localhost:5432/avni";
const APP_SECRET = "test-app-secret";
const PASSPHRASE = "test-passphrase";

let admin: Pool;
let databaseName: string;
let databaseUrl: string;
let bankOne: FakeBankOne;
let middleware: RunningService;
let pool: Pool;
let publicKeyPem: string;
let keyPath: string;

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
    appSecret: APP_SECRET,
    flows: {
      privateKeyPath: keyPath,
      passphrase: PASSPHRASE,
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

const post = async (
  body: unknown,
  options: { signature?: string | null } = {},
): Promise<{ status: number; text: string }> => {
  const raw = JSON.stringify(body);
  const signature =
    options.signature === null ? undefined : (options.signature ?? signFlowBody(raw, APP_SECRET));

  const response = await fetch(`${middleware.url}/flows/whatsapp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(signature ? { "x-hub-signature-256": signature } : {}),
    },
    body: raw,
  });
  return { status: response.status, text: await response.text() };
};

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await admin.query("select 1");
});

afterAll(async () => {
  await admin.end();
});

beforeEach(async () => {
  ({ keyPath, publicKeyPem } = writeFlowsKeypair(PASSPHRASE));

  databaseName = `avni_flows_${randomBytes(6).toString("hex")}`;
  await admin.query(`create database ${databaseName}`);
  databaseUrl = withDatabase(ADMIN_URL, databaseName);

  const migrator = createPool(databaseUrl);
  await applyMigrations(migrator, readMigrations());
  await migrator.end();

  bankOne = await startFakeBankOne({ authToken: "test-auth-token", institutionCode: "test-institution" });
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

describe("the health-check ping", () => {
  it("is answered, sealed under the same key with the flipped IV", async () => {
    const { body, aesKey, initialVector } = sealFlowRequest(publicKeyPem, { version: "3.0", action: "ping" });

    const response = await post(body);

    expect(response.status).toBe(200);
    expect(openFlowResponse(response.text, aesKey, initialVector)).toEqual({ data: { status: "active" } });
  });

  it("answers a bare base64 string rather than JSON", async () => {
    // WhatsApp expects the sealed body itself, not an object wrapping it.
    const { body } = sealFlowRequest(publicKeyPem, { action: "ping" });

    const response = await post(body);

    expect(() => JSON.parse(response.text)).toThrow();
    expect(response.text).toMatch(/^[A-Za-z0-9+/=]+$/);
  });
});

describe("a data exchange", () => {
  it("opens a payload carrying a Transaction PIN and answers sealed", async () => {
    const { body, aesKey, initialVector } = sealFlowRequest(publicKeyPem, {
      version: "3.0",
      action: "data_exchange",
      screen: "PIN",
      data: { pin: "1234" },
    });

    const response = await post(body);

    expect(response.status).toBe(200);
    // No screen handles this yet — tickets 29, 31, 33 and 35 own them — but the
    // exchange stays sealed either way.
    expect(openFlowResponse(response.text, aesKey, initialVector)).toMatchObject({ screen: "ERROR" });
  });

  it("never puts the PIN in the response or on the wire in the clear", async () => {
    const { body } = sealFlowRequest(publicKeyPem, { action: "data_exchange", data: { pin: "9876" } });

    const response = await post(body);

    expect(JSON.stringify(body)).not.toContain("9876");
    expect(response.text).not.toContain("9876");
  });

  it("records the exchange without recording the PIN", async () => {
    const { body } = sealFlowRequest(publicKeyPem, { action: "data_exchange", data: { pin: "1234" } });

    await post(body);

    const entries = await new AuditRepository(pool).read({ action: "flow.exchanged" });
    expect(entries).toHaveLength(1);
    expect(JSON.stringify(entries)).not.toContain("1234");
  });
});

describe("what must be refused", () => {
  it("refuses an unsigned request", async () => {
    const { body } = sealFlowRequest(publicKeyPem, { action: "ping" });

    expect((await post(body, { signature: null })).status).toBe(432);
  });

  it("accepts an unsigned request when the deployment configured no app secret", async () => {
    // **The opt-out, and it is opted into by leaving a key out.** Meta
    // recommends verification and does not require it; a deployment that has
    // not set WHATSAPP_APP_SECRET has said it is running the way the prior art
    // does. What is left in front of this endpoint is the Flows private key.
    const notice = flowSignatureNotice(undefined);
    expect(notice.verifying).toBe(false);
    expect(notice.message).toContain("OFF");

    expect(signatureFailure(Buffer.from("{}"), undefined, undefined)).toBeUndefined();
    // And with a secret configured, the same unsigned request is still refused.
    expect(signatureFailure(Buffer.from("{}"), undefined, APP_SECRET)).toBe("absent");
  });

  it("refuses a request signed with the wrong secret", async () => {
    const { body } = sealFlowRequest(publicKeyPem, { action: "ping" });

    const response = await post(body, {
      signature: signFlowBody(JSON.stringify(body), "not-the-app-secret"),
    });

    expect(response.status).toBe(432);
  });

  it("refuses a signature over a different body, which is a replay", async () => {
    const first = sealFlowRequest(publicKeyPem, { action: "ping" });
    const second = sealFlowRequest(publicKeyPem, { action: "data_exchange" });

    const response = await post(second.body, {
      signature: signFlowBody(JSON.stringify(first.body), APP_SECRET),
    });

    expect(response.status).toBe(432);
  });

  it("asks for a key refresh when the payload will not open", async () => {
    // 421 is what makes the client re-fetch our public key, which is the whole
    // recovery path after a rotation.
    const stranger = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const held = publicKeyPem;
    publicKeyPem = stranger.publicKey;
    const { body } = sealFlowRequest(publicKeyPem, { action: "ping" });
    publicKeyPem = held;

    expect((await post(body)).status).toBe(421);
  });

  it("refuses a tampered body rather than answering what it can read", async () => {
    const { body } = sealFlowRequest(publicKeyPem, { action: "data_exchange", data: { amount: 5000 } });
    const tampered = Buffer.from(body.encrypted_flow_data, "base64");
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;

    const response = await post({ ...body, encrypted_flow_data: tampered.toString("base64") });

    expect(response.status).toBe(421);
  });

  it("refuses a payload that is not the three fields", async () => {
    for (const body of [{}, { encrypted_aes_key: "x" }, { nothing: "useful" }]) {
      expect((await post(body)).status).toBe(421);
    }
  });

  it("leaks nothing about why", async () => {
    const { body } = sealFlowRequest(publicKeyPem, { action: "ping" });

    const unsigned = await post(body, { signature: null });
    const tampered = await post({ ...body, encrypted_flow_data: "AAAA" });

    // A body either way would be an oracle for somebody probing. The reason is
    // in the log and the audit table, where the Bank can reach it.
    expect(unsigned.text).toBe("");
    expect(tampered.text).toBe("");
  });

  it("records a refusal so the Bank can tell probing from an outage", async () => {
    const { body } = sealFlowRequest(publicKeyPem, { action: "ping" });

    await post(body, { signature: null });

    const entries = await new AuditRepository(pool).read({ action: "flow.refused" });
    expect(entries[0]).toMatchObject({ outcome: "refused" });
    expect(entries[0]?.detail["reason"]).toBeTruthy();
  });
});

describe("the private key", () => {
  it("is loaded from the mounted path, so a wrong path stops the boot", async () => {
    const config = configFor();

    await expect(
      createMiddlewareApplication({
        ...config,
        whatsapp: {
          ...config.whatsapp,
          flows: { ...config.whatsapp.flows, privateKeyPath: "/nowhere/missing.pem" },
        },
      }),
    ).rejects.toThrow(/could not be loaded/);
  });

  it("stops the boot on a wrong passphrase rather than at the first authorisation", async () => {
    const config = configFor();

    await expect(
      createMiddlewareApplication({
        ...config,
        whatsapp: {
          ...config.whatsapp,
          flows: { ...config.whatsapp.flows, passphrase: "wrong" },
        },
      }),
    ).rejects.toThrow(/could not be loaded/);
  });
});

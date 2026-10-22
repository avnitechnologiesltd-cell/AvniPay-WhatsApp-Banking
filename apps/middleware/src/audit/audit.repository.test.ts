import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyMigrations, createPool, readMigrations, type Pool } from "@avni/db";

import { AuditRepository } from "./audit.repository";

const ADMIN_URL = process.env["TEST_DATABASE_URL"] ?? "postgres://avni:avni@localhost:5432/avni";
const ACCOUNT = "0123456789";

let admin: Pool;
let databaseName: string;
let pool: Pool;
let audit: AuditRepository;

const withDatabase = (connectionString: string, name: string): string => {
  const url = new URL(connectionString);
  url.pathname = `/${name}`;
  return url.toString();
};

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await admin.query("select 1");
});

afterAll(async () => {
  await admin.end();
});

beforeEach(async () => {
  databaseName = `avni_audit_${randomBytes(6).toString("hex")}`;
  await admin.query(`create database ${databaseName}`);
  pool = createPool(withDatabase(ADMIN_URL, databaseName));
  await applyMigrations(pool, readMigrations());
  audit = new AuditRepository(pool);
});

afterEach(async () => {
  await pool.end();
  await admin.query(`drop database if exists ${databaseName} with (force)`);
});

describe("recording", () => {
  it("carries who, when, what, which account, the outcome and a correlating id", async () => {
    const conversationId = randomUUID();

    await audit.record({
      action: "banking.balance_read",
      actor: { kind: "customer" },
      outcome: "succeeded",
      accountNumber: ACCOUNT,
      conversationId,
    });

    const [entry] = await audit.read();
    expect(entry).toMatchObject({
      action: "banking.balance_read",
      actorKind: "customer",
      outcome: "succeeded",
      accountNumber: ACCOUNT,
      conversationId,
    });
    expect(entry?.recordedAt).toBeInstanceOf(Date);
  });

  it("names an Officer when a human acted", async () => {
    await audit.record({
      action: "binding.revoked",
      actor: { kind: "officer", id: "officer-7" },
      outcome: "succeeded",
      accountNumber: ACCOUNT,
    });

    expect((await audit.read())[0]).toMatchObject({
      actorKind: "officer",
      actorId: "officer-7",
    });
  });

  it("accepts an action the schema has never heard of", async () => {
    // The column is deliberately open, so a later slice adds a row type
    // without a migration. The closed union lives in TypeScript instead.
    await pool.query(
      `insert into audit_entries (action, actor_kind, outcome) values ($1, $2, $3)`,
      ["connector.dispatched", "platform", "succeeded"],
    );

    expect((await audit.read())[0]?.action).toBe("connector.dispatched");
  });

  it("orders by a monotonic id rather than by the clock", async () => {
    // Two events in the same millisecond still have an order, and
    // reconstructing what authorised a debit is exactly that question.
    for (const action of ["conversation.opened", "intent.submitted", "banking.balance_read"] as const) {
      await audit.record({ action, actor: { kind: "platform" }, outcome: "succeeded" });
    }

    const entries = await audit.read();
    expect(entries.map((entry) => entry.action)).toEqual([
      "banking.balance_read",
      "intent.submitted",
      "conversation.opened",
    ]);
    expect(Number(entries[0]?.id)).toBeGreaterThan(Number(entries[2]?.id));
  });

  it("keeps a failure as firmly as a success", async () => {
    await audit.record({
      action: "banking.balance_read",
      actor: { kind: "customer" },
      outcome: "failed",
      accountNumber: ACCOUNT,
    });

    expect((await audit.read())[0]?.outcome).toBe("failed");
  });

  it("distinguishes refused and unavailable from failed", async () => {
    // Three different things a Bank needs to tell apart afterwards: we said no,
    // the Bank's token cannot, and something broke.
    for (const outcome of ["refused", "unavailable", "failed"] as const) {
      await audit.record({ action: "intent.submitted", actor: { kind: "platform" }, outcome });
    }

    expect((await audit.read()).map((entry) => entry.outcome)).toEqual([
      "failed",
      "unavailable",
      "refused",
    ]);
  });

  it("never lets a write failure stop the thing being audited", async () => {
    // An audit table that can stop a Customer reading their balance is an
    // availability risk wearing a compliance costume.
    const broken = new AuditRepository({
      query: () => Promise.reject(new Error("no database")),
    } as unknown as Pool);

    await expect(
      broken.record({ action: "banking.balance_read", actor: { kind: "customer" }, outcome: "succeeded" }),
    ).resolves.toBeUndefined();
  });
});

describe("what must never be written", () => {
  it("redacts a Transaction PIN somebody put in the detail", async () => {
    await audit.record({
      action: "intent.submitted",
      actor: { kind: "platform" },
      outcome: "succeeded",
      detail: { pin: "1234", transactionPin: "1234", attempt: 1 },
    });

    const [entry] = await audit.read();
    expect(entry?.detail["pin"]).toBe("[redacted]");
    expect(entry?.detail["transactionPin"]).toBe("[redacted]");
    expect(entry?.detail["attempt"]).toBe(1);
  });

  it("redacts a credential, a token and a response body", async () => {
    // Ticket 18: a Connector dispatch records the response status only, never
    // the body, which is the Bank's own data we have no reason to retain.
    await audit.record({
      action: "intent.submitted",
      actor: { kind: "platform" },
      outcome: "succeeded",
      detail: { apiKey: "sk-live", authorization: "Bearer x", responseBody: { pan: "1234" }, status: 200 },
    });

    const [entry] = await audit.read();
    expect(entry?.detail["apiKey"]).toBe("[redacted]");
    expect(entry?.detail["authorization"]).toBe("[redacted]");
    expect(entry?.detail["responseBody"]).toBe("[redacted]");
    expect(entry?.detail["status"]).toBe(200);
  });

  it("reaches a secret nested inside the detail", async () => {
    await audit.record({
      action: "intent.submitted",
      actor: { kind: "platform" },
      outcome: "succeeded",
      detail: { request: { headers: { authorization: "Bearer x" }, path: "/thing" } },
    });

    const nested = (await audit.read())[0]?.detail["request"] as Record<string, unknown>;
    expect((nested["headers"] as Record<string, unknown>)["authorization"]).toBe("[redacted]");
    expect(nested["path"]).toBe("/thing");
  });

  it("refuses an actor kind and an outcome the design does not have", async () => {
    await expect(
      pool.query(`insert into audit_entries (action, actor_kind, outcome) values ($1, $2, $3)`, [
        "x",
        "root",
        "succeeded",
      ]),
    ).rejects.toThrow();

    await expect(
      pool.query(`insert into audit_entries (action, actor_kind, outcome) values ($1, $2, $3)`, [
        "x",
        "customer",
        "probably",
      ]),
    ).rejects.toThrow();
  });
});

describe("reading", () => {
  const seed = async (): Promise<string> => {
    const conversationId = randomUUID();
    await audit.record({
      action: "conversation.opened",
      actor: { kind: "platform" },
      outcome: "succeeded",
      accountNumber: ACCOUNT,
      conversationId,
    });
    await audit.record({
      action: "banking.balance_read",
      actor: { kind: "customer" },
      outcome: "succeeded",
      accountNumber: ACCOUNT,
      conversationId,
    });
    await audit.record({
      action: "banking.balance_read",
      actor: { kind: "customer" },
      outcome: "succeeded",
      accountNumber: "9999999999",
    });
    return conversationId;
  };

  it("narrows to one Customer, which is the insider-threat question", async () => {
    await seed();

    const entries = await audit.read({ accountNumber: ACCOUNT });

    expect(entries).toHaveLength(2);
    expect(entries.every((entry) => entry.accountNumber === ACCOUNT)).toBe(true);
  });

  it("narrows to one conversation, which is how a debit is reconstructed", async () => {
    const conversationId = await seed();

    const entries = await audit.read({ conversationId });

    expect(entries).toHaveLength(2);
  });

  it("narrows to one action", async () => {
    await seed();

    expect(await audit.read({ action: "conversation.opened" })).toHaveLength(1);
  });

  it("treats a malformed conversation id as a filter matching nothing", async () => {
    await seed();

    expect(await audit.read({ conversationId: "not-a-uuid" })).toEqual([]);
  });

  it("pages backwards from an id", async () => {
    await seed();
    const all = await audit.read();

    const next = await audit.read({ before: all[0]?.id });

    expect(next.map((entry) => entry.id)).toEqual(all.slice(1).map((entry) => entry.id));
  });

  it("caps how much one read can pull back", async () => {
    for (let index = 0; index < 12; index += 1) {
      await audit.record({ action: "intent.submitted", actor: { kind: "platform" }, outcome: "succeeded" });
    }

    expect(await audit.read({ limit: 5 })).toHaveLength(5);
    expect((await audit.read({ limit: 100_000 })).length).toBeLessThanOrEqual(500);
  });
});

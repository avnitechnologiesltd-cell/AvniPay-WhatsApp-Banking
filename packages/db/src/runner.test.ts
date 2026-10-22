import { randomBytes } from "node:crypto";

import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PendingMigrationsError, assertDatabaseIsMigrated } from "./guard";
import { checksumOf, type Migration } from "./migrations";
import { applyMigrations, appliedVersions } from "./runner";

/**
 * Real Postgres, in Docker. The rules this database will eventually enforce —
 * one live Binding per account, reference deduplication, Mandate single-use —
 * are money-correctness rules, and an in-memory fake would reimplement them
 * approximately and then be the thing the tests assert against.
 */
const ADMIN_URL =
  process.env["TEST_DATABASE_URL"] ?? "postgres://avni:avni@localhost:5432/avni";

const withDatabase = (connectionString: string, name: string): string => {
  const url = new URL(connectionString);
  url.pathname = `/${name}`;
  return url.toString();
};

const migration = (version: string, name: string, sql: string): Migration => ({
  version,
  name,
  filename: `${version}-${name}.sql`,
  sql,
  checksum: checksumOf(sql),
});

let admin: Pool;
let databaseName: string;
let pool: Pool;

beforeAll(async () => {
  admin = new Pool({ connectionString: ADMIN_URL });
  await admin.query("select 1");
});

afterAll(async () => {
  await admin.end();
});

beforeEach(async () => {
  databaseName = `avni_test_${randomBytes(6).toString("hex")}`;
  await admin.query(`create database ${databaseName}`);
  pool = new Pool({ connectionString: withDatabase(ADMIN_URL, databaseName) });
});

afterEach(async () => {
  await pool.end();
  await admin.query(`drop database if exists ${databaseName} with (force)`);
});

describe("applyMigrations", () => {
  it("applies pending migrations in order and records each one", async () => {
    const migrations = [
      migration("0001", "bindings", "create table bindings (account_number text primary key);"),
      migration("0002", "beneficiaries", "create table beneficiaries (id text primary key);"),
    ];

    const result = await applyMigrations(pool, migrations);

    expect(result.applied.map((m) => m.version)).toEqual(["0001", "0002"]);
    expect(await appliedVersions(pool)).toEqual(["0001", "0002"]);
    await expect(pool.query("select * from beneficiaries")).resolves.toBeDefined();
  });

  it("is a no-op the second time, so a repeated release step is safe", async () => {
    const migrations = [migration("0001", "bindings", "create table bindings (id text);")];

    await applyMigrations(pool, migrations);
    const second = await applyMigrations(pool, migrations);

    expect(second.applied).toEqual([]);
    expect(await appliedVersions(pool)).toEqual(["0001"]);
  });

  it("applies only what is pending when a later migration is added", async () => {
    const first = [migration("0001", "bindings", "create table bindings (id text);")];
    await applyMigrations(pool, first);

    const second = await applyMigrations(pool, [
      ...first,
      migration("0002", "mandates", "create table mandates (id text);"),
    ]);

    expect(second.applied.map((m) => m.version)).toEqual(["0002"]);
  });

  it("leaves nothing behind when a migration fails halfway", async () => {
    const migrations = [
      migration(
        "0001",
        "half-broken",
        "create table survivors (id text); create table survivors (id text);",
      ),
    ];

    await expect(applyMigrations(pool, migrations)).rejects.toThrow();

    expect(await appliedVersions(pool)).toEqual([]);
    await expect(pool.query("select * from survivors")).rejects.toThrow();
  });

  it("stops at the first failure rather than running the rest", async () => {
    const migrations = [
      migration("0001", "fine", "create table fine (id text);"),
      migration("0002", "broken", "this is not sql;"),
      migration("0003", "never", "create table never (id text);"),
    ];

    await expect(applyMigrations(pool, migrations)).rejects.toThrow();

    expect(await appliedVersions(pool)).toEqual(["0001"]);
    await expect(pool.query("select * from never")).rejects.toThrow();
  });

  it("refuses to run when an already-applied migration has been edited", async () => {
    await applyMigrations(pool, [
      migration("0001", "bindings", "create table bindings (id text);"),
    ]);

    await expect(
      applyMigrations(pool, [
        migration("0001", "bindings", "create table bindings (id text, extra text);"),
      ]),
    ).rejects.toThrow(/0001.*chang/is);
  });

  it("reports a database ahead of the image without refusing to run", async () => {
    await applyMigrations(pool, [
      migration("0001", "bindings", "create table bindings (id text);"),
      migration("0002", "mandates", "create table mandates (id text);"),
    ]);

    // What an operator sees after rolling back to the previous image: additive-first
    // means that image still serves this schema, so this is a remark, not a failure.
    const result = await applyMigrations(pool, [
      migration("0001", "bindings", "create table bindings (id text);"),
    ]);

    expect(result.applied).toEqual([]);
    expect(result.aheadOfImage).toEqual(["0002"]);
  });
});

describe("assertDatabaseIsMigrated", () => {
  it("refuses a database the migration step has never been run against", async () => {
    await expect(assertDatabaseIsMigrated(pool, [])).rejects.toThrow(PendingMigrationsError);
    await expect(assertDatabaseIsMigrated(pool, [])).rejects.toThrow(/migrate/i);
  });

  it("names every unapplied migration rather than migrating itself", async () => {
    const migrations = [
      migration("0001", "bindings", "create table bindings (id text);"),
      migration("0002", "mandates", "create table mandates (id text);"),
    ];
    await applyMigrations(pool, [migrations[0] as Migration]);

    let thrown: unknown;
    try {
      await assertDatabaseIsMigrated(pool, migrations);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PendingMigrationsError);
    expect((thrown as PendingMigrationsError).pending).toEqual(["0002"]);
    await expect(pool.query("select * from mandates")).rejects.toThrow();
  });

  it("passes once every migration has been applied", async () => {
    const migrations = [migration("0001", "bindings", "create table bindings (id text);")];
    await applyMigrations(pool, migrations);

    await expect(assertDatabaseIsMigrated(pool, migrations)).resolves.toBeUndefined();
  });

  it("passes on an empty migration set once the step has been run", async () => {
    await applyMigrations(pool, []);

    await expect(assertDatabaseIsMigrated(pool, [])).resolves.toBeUndefined();
  });

  it("passes against a database ahead of the image, which is how rollback works", async () => {
    const shipped = [migration("0001", "bindings", "create table bindings (id text);")];
    await applyMigrations(pool, [
      ...shipped,
      migration("0002", "mandates", "create table mandates (id text);"),
    ]);

    await expect(assertDatabaseIsMigrated(pool, shipped)).resolves.toBeUndefined();
  });
});

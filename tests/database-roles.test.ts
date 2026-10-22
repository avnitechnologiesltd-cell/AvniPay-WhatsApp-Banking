import { randomBytes } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  applyMigrations,
  applyRoleGrants,
  createPool,
  readMigrations,
  type Pool,
} from "@avni/db";

/**
 * The release step run the way an operator runs it, against the **real** schema,
 * and then the question ADR-0006 exists to answer asked of Postgres rather than
 * of us: can the prompt-injection surface read the Binding and the hashed
 * Transaction PIN?
 *
 * `packages/db/src/roles.test.ts` proves the grant model works on a table
 * standing in for one. This file proves it holds over **every table the
 * migrations actually create** — which is the part that can rot, because a
 * migration is added by whichever slice needs it and nobody rereads this while
 * writing one.
 */

const ADMIN_URL = process.env["TEST_DATABASE_URL"] ?? "postgres://avni:avni@localhost:5432/avni";

const PASSWORD = "release-step-password";

const withDatabase = (connectionString: string, name: string): string => {
  const url = new URL(connectionString);
  url.pathname = `/${name}`;
  return url.toString();
};

const asRole = (databaseName: string, role: string): string => {
  const url = new URL(withDatabase(ADMIN_URL, databaseName));
  url.username = role;
  url.password = PASSWORD;
  return url.toString();
};

let admin: Pool;
let databaseName: string;
let middlewareRole: string;
let platformRole: string;
let owner: Pool;
let middleware: Pool;
let platform: Pool;

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await admin.query("select 1");
});

afterAll(async () => {
  await admin.end();
});

beforeEach(async () => {
  const suffix = randomBytes(6).toString("hex");
  databaseName = `avni_grants_${suffix}`;
  middlewareRole = `avni_middleware_${suffix}`;
  platformRole = `avni_platform_${suffix}`;

  await admin.query(`create database ${databaseName}`);

  // Exactly what `docker compose run --rm migrate` does, in the order it does
  // it: every migration this image ships, and then the grants.
  owner = createPool(withDatabase(ADMIN_URL, databaseName));
  owner.on("error", () => undefined);
  await applyMigrations(owner, readMigrations());
  await applyRoleGrants(owner, {
    middleware: { role: middlewareRole, password: PASSWORD },
    platform: { role: platformRole, password: PASSWORD },
  });

  middleware = createPool(asRole(databaseName, middlewareRole));
  middleware.on("error", () => undefined);
  platform = createPool(asRole(databaseName, platformRole));
  platform.on("error", () => undefined);
});

afterEach(async () => {
  await Promise.all([middleware.end(), platform.end()]);
  await owner.end();
  await admin.query(`drop database if exists ${databaseName} with (force)`);
  await admin.query(`drop role if exists ${middlewareRole}`);
  await admin.query(`drop role if exists ${platformRole}`);
});

/** Every table the migrations created, whatever schema they put it in. */
const everyTable = async (): Promise<readonly string[]> => {
  const { rows } = await owner.query<{ qualified: string }>(
    `select format('%I.%I', schemaname, tablename) as qualified
       from pg_tables
      where schemaname not in ('pg_catalog', 'information_schema')
      order by 1`,
  );
  return rows.map((row) => row.qualified);
};

describe("the Platform's database role", () => {
  it("can read one table out of everything the migrations made, and it is the bookkeeping one", async () => {
    const tables = await everyTable();
    // A guard against this test passing because the migrations did not run.
    expect(tables.length).toBeGreaterThan(10);

    const reachable: string[] = [];
    const refusedForTheWrongReason: string[] = [];
    for (const table of tables) {
      const refusal = await platform
        .query(`select * from ${table} limit 1`)
        .then(() => undefined)
        .catch((error: unknown) => (error instanceof Error ? error.message : String(error)));

      if (refusal === undefined) reachable.push(table);
      // A refusal that is not about permission — a dropped socket, a table that
      // is not there — would otherwise be counted as evidence of a grant model
      // that might not exist.
      else if (!/permission denied/i.test(refusal)) {
        refusedForTheWrongReason.push(`${table}: ${refusal}`);
      }
    }

    expect(refusedForTheWrongReason).toEqual([]);

    // `schema_migrations` and nothing else. A deployable that refuses to serve
    // against an un-migrated database has to be able to ask whether it was
    // migrated; every other table on this list holds something ADR-0006 says
    // this deployable must not be able to reach.
    expect(reachable).toEqual(["public.schema_migrations"]);
  });

  it("cannot read the Binding or the hashed Transaction PIN, named rather than counted", async () => {
    // The two rows ADR-0006 is actually about. Named here so that a future
    // change which quietly stops covering them fails a test that says why.
    await expect(owner.query("select * from bindings")).resolves.toBeDefined();
    await expect(owner.query("select * from transaction_pins")).resolves.toBeDefined();

    // The refusal has to be a *permission* refusal. A bare `.rejects.toThrow()`
    // would pass on a dropped connection or a mistyped table name, which is the
    // failure this whole file exists to not have.
    await expect(platform.query("select * from bindings")).rejects.toThrow(
      /permission denied/i,
    );
    await expect(platform.query("select * from transaction_pins")).rejects.toThrow(
      /permission denied/i,
    );
  });

  it("still answers the readiness check, which is all it asks of Postgres", async () => {
    await expect(platform.query("select 1")).resolves.toBeDefined();
  });
});

describe("the Middleware's database role", () => {
  it("can read every table, because it is the one that holds them", async () => {
    const unreachable: string[] = [];
    for (const table of await everyTable()) {
      const failed = await middleware
        .query(`select * from ${table} limit 1`)
        .then(() => false)
        .catch(() => true);
      if (failed) unreachable.push(table);
    }

    expect(unreachable).toEqual([]);
  });

  it("cannot change the schema, so a migration stays the only way it moves", async () => {
    await expect(middleware.query("drop table bindings")).rejects.toThrow();
    await expect(middleware.query("alter table bindings add column smuggled text")).rejects.toThrow(
      /must be owner/i,
    );
  });
});

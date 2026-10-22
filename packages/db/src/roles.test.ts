import { randomBytes } from "node:crypto";

import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { RoleModelError, applyRoleGrants, deployableRolesFrom } from "./roles";
import { BOOKKEEPING_TABLE, applyMigrations } from "./runner";

/**
 * Real Postgres, because the property under test *is* Postgres. A fake that
 * reported "permission denied" because we told it to would be asserting our own
 * intention back at us, which is the exact failure ADR-0006 names: "'The
 * Platform is untrusted' has to be enforced, not merely intended."
 */
const ADMIN_URL =
  process.env["TEST_DATABASE_URL"] ?? "postgres://avni:avni@localhost:5432/avni";

const withDatabase = (connectionString: string, name: string): string => {
  const url = new URL(connectionString);
  url.pathname = `/${name}`;
  return url.toString();
};

const asRole = (databaseName: string, role: string, password: string): string => {
  const url = new URL(withDatabase(ADMIN_URL, databaseName));
  // The setter percent-encodes what needs it. Encoding by hand first would
  // double-encode a password containing a `%`, and the three other test files
  // that build one of these do it this way.
  url.username = role;
  url.password = password;
  return url.toString();
};

const PASSWORD = "correct-horse-battery-staple";

let admin: Pool;
let databaseName: string;
let owner: Pool;
let middlewareRole: string;
let platformRole: string;
/** Every pool a test opened, closed for it — a leaked one blocks `drop role`. */
let opened: Pool[];
/** Roles a test made beyond the two above. Dropped after the database, since a
 * role holding a grant in it cannot be dropped before. */
let alsoDrop: string[];

const connectAs = (role: string, password = PASSWORD): Pool => {
  const pool = new Pool({ connectionString: asRole(databaseName, role, password) });
  // `drop database ... with (force)` in afterEach can land on a socket that is
  // still closing, which pg re-raises as an unhandled error without this.
  pool.on("error", () => undefined);
  opened.push(pool);
  return pool;
};

/**
 * The table is really there and this role really cannot read it.
 *
 * **Both halves, and the first one is the point.** A test that only asserted the
 * rejection would pass just as happily on a mistyped table name — the denial
 * would be "does not exist" and would look exactly like a security property. So
 * the owner reads it first; only then is the refusal evidence of anything.
 *
 * What the Platform actually gets is `permission denied for table …`. Withholding
 * `usage on schema public` would make it `does not exist` instead — invisible
 * rather than merely locked, which is stronger — but `usage` is schema-wide and
 * the Platform has to resolve `schema_migrations` by name to find out whether it
 * may start. Both wordings are accepted below, so that tightening this later
 * does not read as a regression.
 */
const cannotReach = async (pool: Pool, table: string): Promise<void> => {
  await expect(owner.query(`select * from ${table}`)).resolves.toBeDefined();
  await expect(pool.query(`select * from ${table}`)).rejects.toThrow(
    /permission denied|does not exist/i,
  );
};

const grants = () => ({
  middleware: { role: middlewareRole, password: PASSWORD },
  platform: { role: platformRole, password: PASSWORD },
});

beforeAll(async () => {
  admin = new Pool({ connectionString: ADMIN_URL });
  await admin.query("select 1");
});

afterAll(async () => {
  await admin.end();
});

beforeEach(async () => {
  const suffix = randomBytes(6).toString("hex");
  databaseName = `avni_roles_${suffix}`;
  middlewareRole = `avni_middleware_${suffix}`;
  platformRole = `avni_platform_${suffix}`;
  opened = [];
  alsoDrop = [];

  await admin.query(`create database ${databaseName}`);
  owner = new Pool({ connectionString: withDatabase(ADMIN_URL, databaseName) });
  owner.on("error", () => undefined);
  // The grants belong after the migrations, so the bookkeeping table exists by
  // the time they run. No migrations to apply here — the schema this file cares
  // about is the one table below.
  await applyMigrations(owner, []);
  // One table standing in for everything the Middleware holds and the Platform
  // must not reach. The real one is `bindings`, from migration 0001.
  await owner.query("create table bindings (account_number text primary key)");
  await owner.query("insert into bindings (account_number) values ('0123456789')");
});

afterEach(async () => {
  for (const pool of opened) await pool.end();
  await owner.end();
  await admin.query(`drop database if exists ${databaseName} with (force)`);
  await admin.query(`drop role if exists ${middlewareRole}`);
  await admin.query(`drop role if exists ${platformRole}`);
  for (const role of alsoDrop) await admin.query(`drop role if exists "${role}"`);
});

describe("the Platform's role", () => {
  it("cannot read the Middleware's tables", async () => {
    await applyRoleGrants(owner, grants());

    await cannotReach(connectAs(platformRole), "bindings");
  });

  it("cannot reach a table created after the grants were applied", async () => {
    await applyRoleGrants(owner, grants());
    await owner.query("create table transaction_pins (account_number text primary key)");

    await cannotReach(connectAs(platformRole), "transaction_pins");
  });

  it("reads the bookkeeping table, and no other, because that is how it knows it may start", async () => {
    // The one table it is granted. A deployable that refuses to serve against
    // an un-migrated database has to be able to find out whether it was
    // migrated, and this is the whole of what that costs.
    await applyRoleGrants(owner, grants());

    const platform = connectAs(platformRole);

    await expect(platform.query(`select * from ${BOOKKEEPING_TABLE}`)).resolves.toBeDefined();
    await cannotReach(platform, "bindings");
  });

  it("cannot write the bookkeeping table it is allowed to read", async () => {
    await applyRoleGrants(owner, grants());

    const platform = connectAs(platformRole);

    await expect(
      platform.query(
        `insert into ${BOOKKEEPING_TABLE} (version, name, checksum) values ('9999', 'invented', 'x')`,
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("can still connect and answer its readiness check, which is all it does", async () => {
    // The Platform issues exactly one statement against Postgres — `select 1`,
    // from the readiness check. It persists nothing, so "connect and nothing
    // else" is the whole of what it needs rather than a restriction it works
    // around.
    await applyRoleGrants(owner, grants());

    const platform = connectAs(platformRole);

    await expect(platform.query("select 1")).resolves.toBeDefined();
  });

  it("cannot create a table of its own to work around the denial", async () => {
    await applyRoleGrants(owner, grants());

    const platform = connectAs(platformRole);

    // It holds `usage` on the schema and not `create`, so it can resolve a name
    // in `public` and can put nothing of its own there. No table of its own
    // means nowhere to accumulate a copy of what it is denied.
    await expect(platform.query("create table smuggled (copied text)")).rejects.toThrow(
      /permission denied|no schema has been selected/i,
    );
  });
});

describe("the Middleware's role", () => {
  it("reads and writes every table", async () => {
    await applyRoleGrants(owner, grants());

    const middleware = connectAs(middlewareRole);

    const { rows } = await middleware.query("select account_number from bindings");
    expect(rows).toEqual([{ account_number: "0123456789" }]);
    await expect(
      middleware.query("insert into bindings (account_number) values ('9876543210')"),
    ).resolves.toBeDefined();
    await expect(middleware.query("delete from bindings")).resolves.toBeDefined();
  });

  it("reaches a table created after the grants were applied", async () => {
    await applyRoleGrants(owner, grants());
    await owner.query("create table transaction_pins (account_number text primary key)");

    const middleware = connectAs(middlewareRole);

    await expect(middleware.query("select * from transaction_pins")).resolves.toBeDefined();
  });

  it("cannot change the schema, because migrations are the only way that happens", async () => {
    await applyRoleGrants(owner, grants());

    const middleware = connectAs(middlewareRole);

    await expect(middleware.query("drop table bindings")).rejects.toThrow(/must be owner/i);
    await expect(middleware.query("create table extra (id text)")).rejects.toThrow(
      /permission denied/i,
    );
  });
});

describe("applyRoleGrants", () => {
  it("refuses to run before the migrations, which is where its ordering lives", async () => {
    const fresh = `avni_roles_unmigrated_${randomBytes(4).toString("hex")}`;
    await admin.query(`create database ${fresh}`);
    const pool = new Pool({ connectionString: withDatabase(ADMIN_URL, fresh) });
    pool.on("error", () => undefined);

    try {
      await expect(applyRoleGrants(pool, grants())).rejects.toThrow(RoleModelError);
    } finally {
      await pool.end();
      await admin.query(`drop database if exists ${fresh} with (force)`);
    }
  });

  it("runs again over a database it has already run against", async () => {
    await applyRoleGrants(owner, grants());
    await applyRoleGrants(owner, grants());

    await cannotReach(connectAs(platformRole), "bindings");
  });

  it("syncs the password, so rotation is editing the file and running it again", async () => {
    await applyRoleGrants(owner, grants());
    await applyRoleGrants(owner, {
      ...grants(),
      middleware: { role: middlewareRole, password: "rotated-and-then-some" },
    });

    const middleware = connectAs(middlewareRole, "rotated-and-then-some");

    await expect(middleware.query("select * from bindings")).resolves.toBeDefined();
  });

  it("survives a password full of the characters that break string building", async () => {
    // `create role … password '…'` takes no bind variable, so the value is
    // built into the statement and the quote doubling is the only thing between
    // a password and a SQL injection in the release step. The `%` and the `@`
    // are here for the other half: this password also has to survive being put
    // into a connection URL and read back out.
    const awkward = "it's-a-'quoted'-one-100%-@-\"double\"";
    await applyRoleGrants(owner, {
      ...grants(),
      middleware: { role: middlewareRole, password: awkward },
    });

    const middleware = connectAs(middlewareRole, awkward);

    await expect(middleware.query("select * from bindings")).resolves.toBeDefined();
  });

  it("survives a role name that would need quoting", async () => {
    // `grant … to <role>` is built into the statement too, so the identifier
    // quoting is load-bearing in exactly the same way the password's is.
    const awkward = `${middlewareRole}-with-a-hyphen`;
    alsoDrop.push(awkward);

    await applyRoleGrants(owner, {
      ...grants(),
      middleware: { role: awkward, password: PASSWORD },
    });

    const middleware = connectAs(awkward);
    await expect(middleware.query("select * from bindings")).resolves.toBeDefined();
  });
});

describe("deployableRolesFrom", () => {
  const url = (role: string, password = "pw"): string =>
    `postgres://${role}:${password}@postgres:5432/avni`;

  it("takes the role and password out of each connection URL", () => {
    expect(
      deployableRolesFrom({
        owner: url("avni"),
        middleware: url("avni_middleware", "mw"),
        platform: url("avni_platform", "pf"),
      }),
    ).toEqual({
      middleware: { role: "avni_middleware", password: "mw" },
      platform: { role: "avni_platform", password: "pf" },
    });
  });

  it("decodes a percent-encoded password", () => {
    const roles = deployableRolesFrom({
      owner: url("avni"),
      middleware: "postgres://avni_middleware:p%40ss%3Aword@postgres:5432/avni",
      platform: url("avni_platform"),
    });

    expect(roles.middleware.password).toBe("p@ss:word");
  });

  it("refuses the Platform and the Middleware sharing one login", () => {
    expect(() =>
      deployableRolesFrom({
        owner: url("avni"),
        middleware: url("avni_app"),
        platform: url("avni_app"),
      }),
    ).toThrow(RoleModelError);
  });

  it("refuses either deployable using the owning login", () => {
    expect(() =>
      deployableRolesFrom({
        owner: url("avni"),
        middleware: url("avni"),
        platform: url("avni_platform"),
      }),
    ).toThrow(/MIDDLEWARE_DATABASE_URL/);
  });

  it("refuses a deployable login with no password", () => {
    expect(() =>
      deployableRolesFrom({
        owner: url("avni"),
        middleware: "postgres://avni_middleware@postgres:5432/avni",
        platform: url("avni_platform"),
      }),
    ).toThrow(/password/i);
  });

  it("asks nothing of the owner's password, because it never sets one", () => {
    // `.env.example` ships DATABASE_URL with the password blank, for the
    // operator to fill in — and a deployment where the owning login
    // authenticates by trust, peer or `.pgpass` never puts one in the URL at
    // all. This step creates the two roles below and sets *their* passwords; the
    // owner's is between the operator and Postgres.
    expect(
      deployableRolesFrom({
        owner: "postgres://avni:@postgres:5432/avni",
        middleware: url("avni_middleware", "mw"),
        platform: url("avni_platform", "pf"),
      }).middleware.role,
    ).toBe("avni_middleware");

    expect(() =>
      deployableRolesFrom({
        owner: "postgres://avni@postgres:5432/avni",
        middleware: url("avni_middleware", "mw"),
        platform: url("avni_platform", "pf"),
      }),
    ).not.toThrow();
  });

  it("refuses a URL that names no role at all", () => {
    expect(() =>
      deployableRolesFrom({
        owner: url("avni"),
        middleware: "postgres://postgres:5432/avni",
        platform: url("avni_platform"),
      }),
    ).toThrow(/MIDDLEWARE_DATABASE_URL/);
  });
});

import type { Pool } from "pg";

import { BOOKKEEPING_TABLE } from "./runner";

/**
 * **"Role" here is Postgres', not the Bank's.** `CONTEXT.md` says the Bank's
 * staff have exactly two roles, Administrator and Support Officer, and those
 * live in `apps/middleware/src/staff/roles.ts`. Nothing in this file is about
 * a person. Everything an operator reads — `.env.example`, `docs/runbook.md` —
 * calls these *logins* for that reason; the code says role because the SQL
 * does.
 *
 * A login one deployable connects as, taken from its own `*_DATABASE_URL`.
 *
 * There is no separate key naming the role: the URL the deployable already
 * connects with *is* the statement of who it is, so the grant model and the
 * connection string cannot drift apart into two facts about one login.
 */
export interface DeployableRole {
  readonly role: string;
  readonly password: string;
}

export interface DeployableRoles {
  readonly middleware: DeployableRole;
  readonly platform: DeployableRole;
}

/**
 * Thrown when the three database URLs do not describe a grant model that could
 * separate anything — one login wearing three names, or a login with no
 * password.
 */
export class RoleModelError extends Error {
  public override readonly name = "RoleModelError";
}

export interface DatabaseUrls {
  /** `DATABASE_URL` — the owning login the migration step runs as. */
  readonly owner: string;
  readonly middleware: string;
  readonly platform: string;
}

const connectionUrl = (url: string, key: string): URL => {
  try {
    return new URL(url);
  } catch {
    throw new RoleModelError(`${key} is not a connection URL.`);
  }
};

/**
 * The role a connection URL names. Only the name — the owning login's password
 * is between the operator and Postgres, and this step never touches it.
 */
const roleNamedBy = (url: string, key: string): string => {
  const role = decodeURIComponent(connectionUrl(url, key).username);
  if (role === "") {
    throw new RoleModelError(
      `${key} names no role. It must be the login that connects with it, because that ` +
        "login is what the grants are applied to.",
    );
  }
  return role;
};

/** A deployable's login, which this step creates and sets the password of. */
const loginNamedBy = (url: string, key: string): DeployableRole => {
  const role = roleNamedBy(url, key);
  const password = decodeURIComponent(connectionUrl(url, key).password);
  if (password === "") {
    throw new RoleModelError(
      `${key} carries no password for ${role}. The migration step creates that role and sets ` +
        "its password from this URL, so a blank one would leave the deployable unable to " +
        "authenticate. (DATABASE_URL is different: that login already exists and this step " +
        "never changes it.)",
    );
  }

  return { role, password };
};

/**
 * Reads the two deployable logins out of the three database URLs, and refuses
 * anything that would make the separation decorative.
 *
 * **This is where "the Platform is untrusted" stops being a sentence.** Three
 * keys that happen to name one login are exactly as reachable as one key —
 * the Binding and the hashed Transaction PIN would be a `SELECT` away from the
 * prompt-injection surface, without anyone having to build the local copy
 * [ADR-0006](../../../docs/adr/0006-secrets-and-security-records-live-outside-the-platform.md)
 * spends its length warning about. So a deployment configured that way does not
 * migrate, and therefore does not start.
 */
export const deployableRolesFrom = (urls: DatabaseUrls): DeployableRoles => {
  const owner = roleNamedBy(urls.owner, "DATABASE_URL");
  const middleware = loginNamedBy(urls.middleware, "MIDDLEWARE_DATABASE_URL");
  const platform = loginNamedBy(urls.platform, "PLATFORM_DATABASE_URL");

  if (middleware.role === platform.role) {
    throw new RoleModelError(
      `MIDDLEWARE_DATABASE_URL and PLATFORM_DATABASE_URL both name ${middleware.role}. ` +
        "One login shared by both puts every Binding and every hashed Transaction PIN one " +
        "SELECT from the prompt-injection surface. Give them separate roles.",
    );
  }

  for (const [key, deployable] of [
    ["MIDDLEWARE_DATABASE_URL", middleware],
    ["PLATFORM_DATABASE_URL", platform],
  ] as const) {
    if (deployable.role === owner) {
      throw new RoleModelError(
        `${key} names ${owner}, which is the owning login from DATABASE_URL. ` +
          "The owner can change the schema; a deployable must not be able to.",
      );
    }
  }

  return { middleware, platform };
};

/**
 * Doubles the quote, which is the whole of Postgres' escaping rule for both
 * identifiers and literals while `standard_conforming_strings` is on — it has
 * been on by default since 9.1 and the Compose image does not turn it off. Used
 * because `create role` and `grant` take neither parameters nor bind variables.
 */
const identifier = (value: string): string => `"${value.replace(/"/g, '""')}"`;
const literal = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/**
 * Creates the two deployable roles if they are absent, syncs their passwords,
 * and applies the grants — **run by the migration step, after the migrations**.
 *
 * After, rather than before, and every time rather than once: a migration that
 * creates a table would otherwise leave the Middleware unable to read it until
 * somebody remembered a `GRANT`. The default privileges below cover a table
 * created between two runs; the blanket grants cover everything the database
 * already has. Neither alone is enough, and together they mean the grant model
 * is a property of the release step rather than of anyone's memory.
 *
 * The shape of it is short because the Platform's needs are:
 *
 * - **The Platform gets `CONNECT`, and `SELECT` on one table.** It issues one
 *   statement against Postgres in the whole codebase — `select 1`, from the
 *   readiness check — and persists nothing at all. The one table is
 *   `schema_migrations`, because a deployable that refuses to start against an
 *   un-migrated database has to be able to find out whether it was migrated.
 *   That is the entirety of what the Platform does with Postgres, written down.
 * - **The Middleware gets DML on every table and no DDL.** It owns nothing, so
 *   it cannot drop or alter what it reads. The schema changes in exactly one
 *   place, which is a file in `migrations/`.
 * - **`PUBLIC` gets nothing**, because a privilege granted to `PUBLIC` is
 *   granted to the Platform too, and the whole point of the paragraph above is
 *   that the Platform holds no privilege it was not handed deliberately.
 */
export const applyRoleGrants = async (pool: Pool, roles: DeployableRoles): Promise<void> => {
  // Re-checked here rather than trusted from `deployableRolesFrom`, because
  // this function is exported and a caller can hand it a pair it built itself —
  // the tests do. One shared login is the failure the whole file exists to
  // prevent, and it is not worth making that depend on the route taken here.
  if (roles.middleware.role === roles.platform.role) {
    throw new RoleModelError(
      `Refusing to grant: the Middleware and the Platform both name ${roles.middleware.role}. ` +
        "Granting the Middleware's privileges to a role the Platform also connects as would " +
        "hand every Binding and every hashed Transaction PIN to the prompt-injection surface.",
    );
  }

  const { rows } = await pool.query<{ database: string }>("select current_database() as database");
  const database = identifier(rows[0]?.database ?? "");

  const { rows: bookkeeping } = await pool.query<{ present: boolean }>(
    "select to_regclass($1) is not null as present",
    [BOOKKEEPING_TABLE],
  );
  if (bookkeeping[0]?.present !== true) {
    throw new RoleModelError(
      `Refusing to grant: ${BOOKKEEPING_TABLE} is absent, so the migrations have not been ` +
        "applied. The grants belong after them — a table created by a migration needs granting " +
        "on, and the Platform needs to read this one to find out whether it may start.",
    );
  }

  // Anything PUBLIC holds, the Platform holds. Revoked first, so that the
  // grants below are the complete list of who can reach what.
  await pool.query(`revoke all on database ${database} from public`);
  await pool.query("revoke all on schema public from public");
  await pool.query("revoke all on all tables in schema public from public");

  await ensureRole(pool, roles.middleware);
  await ensureRole(pool, roles.platform);

  const middleware = identifier(roles.middleware.role);
  await pool.query(`grant connect on database ${database} to ${middleware}`);
  await pool.query(`grant usage on schema public to ${middleware}`);
  await pool.query(
    `grant select, insert, update, delete on all tables in schema public to ${middleware}`,
  );
  await pool.query(`grant usage, select on all sequences in schema public to ${middleware}`);
  // For whatever the next migration creates. Scoped to objects this connection's
  // role creates, which is the migration step and nothing else.
  await pool.query(
    `alter default privileges in schema public
       grant select, insert, update, delete on tables to ${middleware}`,
  );
  await pool.query(
    `alter default privileges in schema public grant usage, select on sequences to ${middleware}`,
  );

  // Connect, read the bookkeeping table, and stop. The revokes are stated as
  // well as implied by omission, so that a role an operator hand-granted
  // something to on a bad afternoon is put back by the next release.
  const platform = identifier(roles.platform.role);
  await pool.query(`grant connect on database ${database} to ${platform}`);
  await pool.query(`revoke all on schema public from ${platform}`);
  await pool.query(`revoke all on all tables in schema public from ${platform}`);
  await pool.query(`revoke all on all sequences in schema public from ${platform}`);
  // `usage` without `create`: it may resolve a name in the schema, and may put
  // nothing of its own there.
  await pool.query(`grant usage on schema public to ${platform}`);
  await pool.query(`grant select on ${identifier(BOOKKEEPING_TABLE)} to ${platform}`);
};

const ensureRole = async (pool: Pool, { role, password }: DeployableRole): Promise<void> => {
  const { rowCount } = await pool.query("select 1 from pg_roles where rolname = $1", [role]);
  const verb = rowCount === 0 ? "create role" : "alter role";

  // No SUPERUSER/NOSUPERUSER clause: a CREATEROLE login that is not itself a
  // superuser may not use one, and omitting it means this step works whether
  // DATABASE_URL is the Compose superuser or a role the Bank's DBA delegated.
  await pool.query(
    `${verb} ${identifier(role)} with login nocreatedb nocreaterole password ${literal(password)}`,
  );
};

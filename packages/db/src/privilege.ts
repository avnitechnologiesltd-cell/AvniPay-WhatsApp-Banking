import type { Pool } from "pg";

import { BOOKKEEPING_TABLE } from "./runner";

/**
 * Which side of [ADR-0006](../../../docs/adr/0006-secrets-and-security-records-live-outside-the-platform.md)
 * a deployable is on, as its own database login should see it.
 *
 * Every deployable states one. There is no default and no way to omit it —
 * "the Platform is untrusted" being enforced rather than intended is the whole
 * point, and a deployable that could stay silent about which side it is on is a
 * deployable that ends up on the wrong one quietly.
 */
export type DatabaseAccess =
  /** The Middleware. Holds the Binding, the hashed Transaction PIN, every Mandate. */
  | "holds-the-security-records"
  /** The Platform. The prompt-injection surface, and it must reach none of them. */
  | "holds-none-of-them";

/**
 * Thrown at boot by a deployable whose database login can reach more than its
 * side of ADR-0006 allows.
 */
export class DatabasePrivilegeError extends Error {
  public override readonly name = "DatabasePrivilegeError";

  public constructor(
    /** Tables this login can read that it should not be able to. */
    public readonly reachable: readonly string[],
  ) {
    super(
      `This deployable's database login can read ${reachable.length} table(s) it must not: ` +
        `${reachable.slice(0, 5).join(", ")}${reachable.length > 5 ? ", …" : ""}. ` +
        "It is the prompt-injection surface and holds no security record, so a login that " +
        "can reach one puts every Binding and every hashed Transaction PIN a SELECT away. " +
        "Give PLATFORM_DATABASE_URL a role of its own and run the migration step, which " +
        "applies the grants: `docker compose run --rm migrate`.",
    );
  }
}

/**
 * Asks Postgres what this connection may actually read, and refuses to serve if
 * the answer is wider than this deployable's side of ADR-0006.
 *
 * **Why here as well as in the migration step.** That step refuses a
 * configuration whose three database URLs name one login — but it only runs
 * when somebody runs it. Editing `.env` to point two deployables at one login
 * and running `docker compose up -d` on an already-migrated database never
 * reaches it. This is the check that cannot be skipped by not doing something,
 * and it asks the database rather than the configuration, so it is also true
 * for a grant an operator changed by hand afterwards.
 *
 * Only the Platform's side is enforced. The Middleware's access is not asserted
 * because a login too *narrow* fails loudly at the first query and needs no
 * boot check, while a login too *wide* on the Platform's side is silent until
 * somebody exploits it — the asymmetry is deliberate and is stated here rather
 * than left to be inferred from the absence of a branch.
 */
export const assertDatabaseAccess = async (
  pool: Pool,
  access: DatabaseAccess,
): Promise<void> => {
  if (access === "holds-the-security-records") return;

  const { rows } = await pool.query<{ qualified: string }>(
    `select format('%I.%I', schemaname, tablename) as qualified
       from pg_tables
      where schemaname not in ('pg_catalog', 'information_schema')
        and tablename <> $1
        and has_table_privilege(
              format('%I.%I', schemaname, tablename),
              'select, insert, update, delete, truncate, references, trigger'
            )
      order by 1`,
    [BOOKKEEPING_TABLE],
  );

  if (rows.length > 0) throw new DatabasePrivilegeError(rows.map((row) => row.qualified));
};

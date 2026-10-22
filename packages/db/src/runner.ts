import type { Pool } from "pg";

import type { Migration } from "./migrations";

/** The bookkeeping table. Created by the migration step, by nothing else. */
export const BOOKKEEPING_TABLE = "schema_migrations";

const CREATE_BOOKKEEPING_TABLE = `
  create table if not exists ${BOOKKEEPING_TABLE} (
    version     text primary key,
    name        text        not null,
    checksum    text        not null,
    applied_at  timestamptz not null default now()
  )
`;

export interface AppliedMigration {
  readonly version: string;
  readonly name: string;
  readonly checksum: string;
}

export interface MigrationResult {
  /** What this run applied, in the order it applied them. */
  readonly applied: readonly Migration[];
  /**
   * Versions the database has that this image does not ship. Expected after a
   * rollback: additive-first means the previous image still serves the newer
   * schema, so this is worth saying out loud and not worth refusing over.
   */
  readonly aheadOfImage: readonly string[];
}

/** True once the migration step has been run against this database at all. */
export const isBookkeepingTablePresent = async (pool: Pool): Promise<boolean> => {
  const { rows } = await pool.query<{ present: boolean }>(
    "select to_regclass($1) is not null as present",
    [BOOKKEEPING_TABLE],
  );
  return rows[0]?.present ?? false;
};

export const appliedMigrations = async (pool: Pool): Promise<readonly AppliedMigration[]> => {
  if (!(await isBookkeepingTablePresent(pool))) return [];
  const { rows } = await pool.query<AppliedMigration>(
    `select version, name, checksum from ${BOOKKEEPING_TABLE} order by version`,
  );
  return rows;
};

export const appliedVersions = async (pool: Pool): Promise<readonly string[]> =>
  (await appliedMigrations(pool)).map((m) => m.version);

/**
 * Applies every migration the database has not seen, each in its own
 * transaction, stopping at the first failure. Never called at boot: a bad
 * deploy that migrates itself is how a bad deploy becomes a bad database, and
 * this one holds Bindings, hashed Transaction PINs, Beneficiaries and Mandates.
 */
export const applyMigrations = async (
  pool: Pool,
  migrations: readonly Migration[],
): Promise<MigrationResult> => {
  await pool.query(CREATE_BOOKKEEPING_TABLE);

  const alreadyApplied = new Map(
    (await appliedMigrations(pool)).map((row) => [row.version, row] as const),
  );

  for (const migration of migrations) {
    const previous = alreadyApplied.get(migration.version);
    if (previous && previous.checksum !== migration.checksum) {
      throw new Error(
        `Migration ${migration.version} (${previous.name}) has changed since it was applied. ` +
          "An applied migration is two different schemas wearing one version number once it is " +
          "edited; add a new migration instead.",
      );
    }
  }

  const shipped = new Set(migrations.map((m) => m.version));
  const aheadOfImage = [...alreadyApplied.keys()].filter((version) => !shipped.has(version)).sort();

  const applied: Migration[] = [];
  for (const migration of migrations) {
    if (alreadyApplied.has(migration.version)) continue;

    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(migration.sql);
      await client.query(
        `insert into ${BOOKKEEPING_TABLE} (version, name, checksum) values ($1, $2, $3)`,
        [migration.version, migration.name, migration.checksum],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw new Error(`Migration ${migration.filename} failed: ${messageOf(error)}`, {
        cause: error,
      });
    } finally {
      client.release();
    }
    applied.push(migration);
  }

  return { applied, aheadOfImage };
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

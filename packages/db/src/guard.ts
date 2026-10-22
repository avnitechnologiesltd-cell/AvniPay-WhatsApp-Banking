import type { Pool } from "pg";

import type { Migration } from "./migrations";
import { appliedVersions, isBookkeepingTablePresent } from "./runner";

/**
 * Thrown at boot by a deployable whose database has not had the migration step
 * run against it. The deployable refuses to serve; it does not migrate itself.
 */
export class PendingMigrationsError extends Error {
  public override readonly name = "PendingMigrationsError";

  public constructor(
    /** Versions this image ships that the database has not applied. */
    public readonly pending: readonly string[],
    /** True when the migration step has never been run against this database. */
    public readonly neverMigrated: boolean,
  ) {
    super(
      neverMigrated
        ? "This database has never been migrated. Run the migration step before starting: " +
            "`docker compose run --rm migrate`."
        : `This database is missing ${pending.length} migration(s): ${pending.join(", ")}. ` +
            "Run the migration step before starting: `docker compose run --rm migrate`.",
    );
  }
}

/**
 * Checks the database carries every migration this image ships, and throws
 * loudly if it does not.
 *
 * A database *ahead* of the image passes: migrations are additive-first, so the
 * previous image still serves a newer schema, and that is what makes "roll back
 * by redeploying the previous image" true rather than aspirational.
 */
export const assertDatabaseIsMigrated = async (
  pool: Pool,
  migrations: readonly Migration[],
): Promise<void> => {
  if (!(await isBookkeepingTablePresent(pool))) {
    throw new PendingMigrationsError(
      migrations.map((m) => m.version),
      true,
    );
  }

  const applied = new Set(await appliedVersions(pool));
  const pending = migrations.map((m) => m.version).filter((version) => !applied.has(version));

  if (pending.length > 0) throw new PendingMigrationsError(pending, false);
};

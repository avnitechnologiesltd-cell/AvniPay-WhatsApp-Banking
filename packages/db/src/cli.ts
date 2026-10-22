import { loadDatabaseConfig } from "@avni/config";

import { readMigrations } from "./migrations";
import { createPool } from "./pool";
import { applyRoleGrants, deployableRolesFrom } from "./roles";
import { applyMigrations } from "./runner";

/**
 * The explicit release step. Run by whoever holds production access, never by a
 * deployable starting up.
 *
 * Two things happen here, in this order: the migrations, and then the grants
 * that decide which login may read what. The grants run every time rather than
 * once, because a migration that creates a table is exactly when the Middleware
 * needs reaching it and the Platform needs not.
 */
const main = async (): Promise<void> => {
  const { databaseUrl, middlewareDatabaseUrl, platformDatabaseUrl } = loadDatabaseConfig();

  // Before anything touches the schema: a deployment whose three database URLs
  // name one login cannot separate anything, and finding that out after the
  // migrations have run is finding it out too late.
  const roles = deployableRolesFrom({
    owner: databaseUrl,
    middleware: middlewareDatabaseUrl,
    platform: platformDatabaseUrl,
  });

  const migrations = readMigrations();
  const pool = createPool(databaseUrl);

  try {
    process.stdout.write(`migrate: ${migrations.length} migration(s) in this image\n`);
    const { applied, aheadOfImage } = await applyMigrations(pool, migrations);

    for (const migration of applied) {
      process.stdout.write(`migrate: applied ${migration.filename}\n`);
    }
    if (applied.length === 0) {
      process.stdout.write("migrate: nothing to apply\n");
    }
    if (aheadOfImage.length > 0) {
      process.stdout.write(
        `migrate: the database also carries ${aheadOfImage.join(", ")}, which this image does ` +
          "not ship. Expected after rolling back to a previous image.\n",
      );
    }

    await applyRoleGrants(pool, roles);
    process.stdout.write(
      `migrate: ${roles.middleware.role} reads and writes every table; ` +
        `${roles.platform.role} may connect and nothing more\n`,
    );
    process.stdout.write("migrate: done\n");
  } finally {
    await pool.end();
  }
};

main().catch((error: unknown) => {
  process.stderr.write(`migrate: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

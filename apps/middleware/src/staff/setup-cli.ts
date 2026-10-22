import { createInterface } from "node:readline/promises";

import { loadMiddlewareConfig } from "@avni/config";
import { assertDatabaseIsMigrated, createPool, readMigrations } from "@avni/db";

import { runSetup } from "./setup";

/**
 * The terminal half of the first-Administrator setup step. Everything that
 * decides anything is in `setup.ts`, where it is tested.
 *
 *     docker compose run --rm setup-administrator
 *
 * A deliberate step somebody runs, like the migration step — never on first
 * boot. The prior art created a default `admin` from a config value the moment
 * it started, which leaves a fresh deployment reachable with a known password
 * for as long as nobody notices.
 */
const main = async (): Promise<void> => {
  const config = loadMiddlewareConfig();
  const pool = createPool(config.databaseUrl);

  try {
    await assertDatabaseIsMigrated(pool, readMigrations());

    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const result = await runSetup(pool, {
        ask: (question) => prompt.question(question),
        say: (line) => process.stdout.write(`${line}\n`),
        issuer: config.bankName,
      });

      // A non-zero exit is what a release script checks.
      if (result.outcome === "refused" || result.outcome === "created_without_mfa") {
        process.exitCode = 1;
      }
    } finally {
      prompt.close();
    }
  } finally {
    await pool.end();
  }
};

main().catch((error: unknown) => {
  process.stderr.write(`setup: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

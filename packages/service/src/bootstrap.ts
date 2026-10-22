import type { AddressInfo } from "node:net";

import type { INestApplication } from "@nestjs/common";

import {
  DatabasePrivilegeError,
  PendingMigrationsError,
  assertDatabaseAccess,
  assertDatabaseIsMigrated,
  readMigrations,
  type DatabaseAccess,
  type Pool,
} from "@avni/db";

import type { StdoutLogger } from "./logger";

export interface StartOptions {
  readonly app: INestApplication;
  readonly service: string;
  readonly logger: StdoutLogger;
  /** `0` asks the operating system for a free port, which is what a test wants. */
  readonly port: number;
  /**
   * Required, not optional. The schema check runs before the deployable serves
   * anything, and a future deployable must not be able to skip it by leaving an
   * argument out — "fails loudly rather than migrating itself" has to be
   * structural for the same reason the module boundaries are.
   *
   * Never migrated here: auto-migrate-on-startup is what turns a bad deploy
   * into a bad database, and this one holds hashed Transaction PINs.
   */
  readonly pool: Pool;
  /**
   * Which side of ADR-0006 this deployable is on. Required for the same reason
   * `pool` is: a deployable that could stay silent about it is one that ends up
   * on the wrong side quietly.
   *
   * Checked against what Postgres says the login may actually read, so it is
   * the deployment that has to be right rather than this argument.
   */
  readonly databaseAccess: DatabaseAccess;
}

export interface RunningService {
  readonly url: string;
  readonly close: () => Promise<void>;
}

export const startService = async (options: StartOptions): Promise<RunningService> => {
  const { app, databaseAccess, logger, port, pool, service } = options;

  try {
    await assertDatabaseIsMigrated(pool, readMigrations());
    // After the schema check, because "which tables may this login read" is a
    // question with no meaning until there are tables to have been granted on.
    await assertDatabaseAccess(pool, databaseAccess);
  } catch (error) {
    // Nothing has been served and nothing should be left holding a connection.
    await app.close().catch(() => undefined);
    throw error;
  }
  logger.log("schema is up to date", "Bootstrap");

  app.enableShutdownHooks();
  await app.listen(port, "0.0.0.0");

  const address = app.getHttpServer().address() as AddressInfo | string | null;
  const boundPort = typeof address === "object" && address !== null ? address.port : port;
  const url = `http://127.0.0.1:${boundPort}`;

  logger.log({ event: "listening", service, port: boundPort }, "Bootstrap");

  return { url, close: () => app.close() };
};

/**
 * Wraps a deployable's entry point so a database that has not had the migration
 * step run against it — or one whose grants leave this deployable able to read
 * more than it should — stops the process with a message an operator can act
 * on, rather than a stack trace at the first query.
 */
export const runEntryPoint = async (
  start: () => Promise<RunningService>,
): Promise<void> => {
  try {
    await start();
  } catch (error) {
    if (error instanceof PendingMigrationsError || error instanceof DatabasePrivilegeError) {
      process.stderr.write(`${error.message}\n`);
    } else {
      process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    }
    process.exitCode = 1;
  }
};

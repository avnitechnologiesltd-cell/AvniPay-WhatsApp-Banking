import { Pool } from "pg";

export type { Pool } from "pg";

/**
 * Postgres is the only datastore. Every additional service is something the
 * Bank's team must run, back up, patch, and be woken up by at 3am.
 */
export const createPool = (databaseUrl: string): Pool => {
  const pool = new Pool({
    connectionString: databaseUrl,
    // Small, because a single VM runs all three deployables beside the database.
    max: 10,
    connectionTimeoutMillis: 10_000,
  });
  // An idle client the server drops — Postgres restarting, a connection
  // terminated by an operator — is discarded by the pool and the next query
  // opens a fresh one. Without a listener, pg re-raises it as an unhandled
  // error and takes the whole process down with it.
  pool.on("error", () => undefined);
  return pool;
};

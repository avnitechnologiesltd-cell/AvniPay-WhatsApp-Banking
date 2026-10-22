import type { Pool } from "@avni/db";

import type { ReadinessCheck } from "./health";

/** Postgres is the only datastore, so it is the only readiness check there is. */
export const databaseReadinessCheck = (pool: Pool): ReadinessCheck => ({
  name: "postgres",
  check: async () => {
    await pool.query("select 1");
  },
});

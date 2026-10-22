import { NextResponse } from "next/server";

import { loadDashboardConfig } from "@avni/config";

import { version } from "../../../../package.json";

export const dynamic = "force-dynamic";

/**
 * Liveness. The Dashboard has no datastore of its own — it reads the
 * Middleware's audit table and the Platform's surfaces over HTTP — so there is
 * nothing here to be un-migrated against.
 *
 * The configuration was already validated at boot by `instrumentation.ts`; this
 * reads it back only to report which deployment answered.
 */
export const GET = (): NextResponse => {
  const config = loadDashboardConfig();

  return NextResponse.json({
    status: "ok",
    service: "dashboard",
    version,
    environment: config.environment,
    uptimeSeconds: Math.round(process.uptime()),
  });
};

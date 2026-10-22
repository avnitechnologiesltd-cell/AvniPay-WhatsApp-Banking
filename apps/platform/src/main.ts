import { loadPlatformConfig } from "@avni/config";
import { runEntryPoint, startService } from "@avni/service";

import { createPlatformApplication } from "./index";
import { SERVICE_NAME } from "./platform.module";

void runEntryPoint(async () => {
  const config = loadPlatformConfig();
  const { app, pool, logger } = await createPlatformApplication(config);

  return startService({
    app,
    pool,
    logger,
    service: SERVICE_NAME,
    port: config.port,
    // ADR-0006. Checked against what Postgres says this login may read, so a
    // deployment that points this at the Middleware's role refuses to serve.
    databaseAccess: "holds-none-of-them",
  });
});

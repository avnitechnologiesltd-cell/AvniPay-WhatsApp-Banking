import { loadMiddlewareConfig } from "@avni/config";
import { runEntryPoint, startService } from "@avni/service";

import { createMiddlewareApplication } from "./index";
import { SERVICE_NAME } from "./middleware.module";

void runEntryPoint(async () => {
  const config = loadMiddlewareConfig();
  const { app, pool, logger } = await createMiddlewareApplication(config);

  return startService({
    app,
    pool,
    logger,
    service: SERVICE_NAME,
    port: config.port,
    databaseAccess: "holds-the-security-records",
  });
});

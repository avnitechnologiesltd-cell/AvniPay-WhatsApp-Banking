import { loadDashboardConfig } from "@avni/config";

import { version } from "../package.json";

/**
 * Next's boot hook. The Dashboard validates its configuration here rather than
 * in a request handler, so a deployment pointed at nothing fails at startup
 * instead of serving pages and only admitting it when somebody asks for health.
 *
 * The Middleware and the Platform get this from `startService`; Next has no
 * equivalent, so it is spelled out.
 */
export const register = (): void => {
  const config = loadDashboardConfig();

  process.stdout.write(
    `${JSON.stringify({
      time: new Date().toISOString(),
      level: "info",
      service: "dashboard",
      context: "Bootstrap",
      message: {
        event: "listening",
        service: "dashboard",
        version,
        environment: config.environment,
        port: config.port,
      },
    })}\n`,
  );
};

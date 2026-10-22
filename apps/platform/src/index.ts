import "reflect-metadata";

import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

import type { PlatformConfig } from "@avni/config";
import { createPool, type Pool } from "@avni/db";
import { StdoutLogger } from "@avni/service";

import { PlatformModule, SERVICE_NAME } from "./platform.module";

export { PLATFORM_CONFIG, PlatformModule, SERVICE_NAME } from "./platform.module";

export interface PlatformApplication {
  readonly app: INestApplication;
  readonly pool: Pool;
  readonly logger: StdoutLogger;
}

/**
 * Builds the Platform from a configuration object rather than from the
 * environment, so a test can boot it beside the Middleware with Groq and every
 * other external base URL pointed at an arbitrary address.
 */
export const createPlatformApplication = async (
  config: PlatformConfig,
): Promise<PlatformApplication> => {
  const logger = new StdoutLogger({ service: SERVICE_NAME, level: config.logLevel });
  const pool = createPool(config.databaseUrl);
  const app = await NestFactory.create(PlatformModule.forConfig(config, pool), {
    logger,
    // Reject rather than `process.abort()`, so a boot failure reaches
    // `runEntryPoint` as a message rather than a core dump.
    abortOnError: false,
  });

  return { app, pool, logger };
};

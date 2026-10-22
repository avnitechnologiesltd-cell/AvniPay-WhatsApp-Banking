import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Inject, Module, type DynamicModule, type OnApplicationShutdown } from "@nestjs/common";

import type { Pool } from "@avni/db";

export const DATABASE_POOL = Symbol("DATABASE_POOL");

/**
 * Owns the connection pool's lifetime so that closing the application closes
 * the database with it, and a test that boots a deployable leaves nothing open.
 */
@Module({})
export class DatabaseModule implements OnApplicationShutdown {
  public constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  public static forPool(pool: Pool): DynamicModule {
    return {
      module: DatabaseModule,
      global: true,
      providers: [{ provide: DATABASE_POOL, useValue: pool }],
      exports: [DATABASE_POOL],
    };
  }

  public async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * The version in the health body, so an operator can see which image is
 * running — which is what makes "roll back by redeploying the previous image"
 * something they can confirm rather than hope.
 */
export const versionOf = (packageDirectory: string): string => {
  try {
    const manifest = JSON.parse(
      readFileSync(join(packageDirectory, "package.json"), "utf8"),
    ) as { version?: string };
    return manifest.version ?? "unknown";
  } catch {
    return "unknown";
  }
};

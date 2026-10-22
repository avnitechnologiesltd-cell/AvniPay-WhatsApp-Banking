import { resolve } from "node:path";

import { defineConfig } from "vitest/config";

const fromRoot = (relative: string): string => resolve(__dirname, relative);

/**
 * Tests run against package sources rather than build output, so the loop is
 * fast. The module boundaries this aliasing papers over are enforced by
 * `pnpm typecheck` and by `tests/module-boundaries.test.ts`.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@avni/config": fromRoot("packages/config/src/index.ts"),
      "@avni/db": fromRoot("packages/db/src/index.ts"),
      "@avni/fakes": fromRoot("packages/fakes/src/index.ts"),
      "@avni/intent": fromRoot("packages/intent/src/index.ts"),
      "@avni/service": fromRoot("packages/service/src/index.ts"),
      "@avni/platform-channels": fromRoot("packages/platform-channels/src/index.ts"),
      "@avni/platform-orchestration": fromRoot("packages/platform-orchestration/src/index.ts"),
      "@avni/platform-support": fromRoot("packages/platform-support/src/index.ts"),
      "@avni/middleware": fromRoot("apps/middleware/src/index.ts"),
      "@avni/platform": fromRoot("apps/platform/src/index.ts"),
    },
  },
  test: {
    include: [
      "packages/*/src/**/*.test.ts",
      "apps/*/src/**/*.test.ts",
      "tests/**/*.test.ts",
    ],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: "forks",
  },
});

# One file, four targets: the three deployables plus the migration step. They
# share a dependency install and a build, so what runs in production is what the
# test suite ran against.

FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /repo
ENV CI=true

# --- manifests only, so a source edit does not reinstall the world ------------
FROM base AS manifests
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/config/package.json packages/config/
COPY packages/db/package.json packages/db/
COPY packages/fakes/package.json packages/fakes/
COPY packages/intent/package.json packages/intent/
COPY packages/service/package.json packages/service/
COPY packages/platform-channels/package.json packages/platform-channels/
COPY packages/platform-orchestration/package.json packages/platform-orchestration/
COPY packages/platform-support/package.json packages/platform-support/
COPY apps/middleware/package.json apps/middleware/
COPY apps/platform/package.json apps/platform/
COPY apps/dashboard/package.json apps/dashboard/

# --- build --------------------------------------------------------------------
FROM manifests AS build
RUN pnpm install --frozen-lockfile
COPY tsconfig.base.json tsconfig.json ./
COPY packages packages
COPY apps apps
RUN pnpm exec tsc --build
RUN pnpm --filter @avni/dashboard run build

# --- runtime dependencies, without the toolchain -------------------------------
FROM manifests AS runtime-deps
RUN pnpm install --frozen-lockfile --prod

# --- the Node deployables ------------------------------------------------------
FROM base AS node-runtime
ENV NODE_ENV=production
COPY --from=runtime-deps /repo /repo
COPY --from=build /repo/packages/config/dist packages/config/dist
COPY --from=build /repo/packages/db/dist packages/db/dist
COPY --from=build /repo/packages/db/migrations packages/db/migrations
COPY --from=build /repo/packages/intent/dist packages/intent/dist
COPY --from=build /repo/packages/service/dist packages/service/dist
USER node

# The Node targets keep /repo as their working directory, so a relative key path
# in `.env` means the same thing in a container as on a developer's machine. The
# Dashboard target below cannot — Next's standalone server wants the app
# directory — and does not need to, because it reads no key material.
FROM node-runtime AS middleware
COPY --from=build /repo/apps/middleware/dist apps/middleware/dist
CMD ["node", "apps/middleware/dist/main.js"]

FROM node-runtime AS platform
COPY --from=build /repo/packages/platform-channels/dist packages/platform-channels/dist
COPY --from=build /repo/packages/platform-orchestration/dist packages/platform-orchestration/dist
COPY --from=build /repo/packages/platform-support/dist packages/platform-support/dist
COPY --from=build /repo/apps/platform/dist apps/platform/dist
CMD ["node", "apps/platform/dist/main.js"]

# --- the Dashboard --------------------------------------------------------------
FROM base AS dashboard
ENV NODE_ENV=production
# Next's standalone output carries the server and only the modules it traced.
COPY --from=build /repo/apps/dashboard/.next/standalone ./
COPY --from=build /repo/apps/dashboard/.next/static ./apps/dashboard/.next/static
WORKDIR /repo/apps/dashboard
USER node
# DASHBOARD_PORT is the documented name in `.env`; Next's server reads PORT.
CMD ["sh", "-c", "PORT=${DASHBOARD_PORT:-3003} HOSTNAME=0.0.0.0 exec node server.js"]

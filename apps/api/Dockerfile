FROM node:24-alpine AS base
# Read the pnpm version directly from the repo root package.json to ensure
# lockfile resolution stays reproducible across local and CI Docker builds.
COPY package.json /tmp/package.json
RUN corepack enable && corepack prepare $(node -e "console.log(require('/tmp/package.json').packageManager)") --activate

# Install all dependencies (for building)
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/shared-mobility/package.json packages/shared-mobility/
COPY packages/mobility-formats/package.json packages/mobility-formats/
COPY packages/hey-api-client-fetch/package.json packages/hey-api-client-fetch/
COPY packages/i18n/package.json packages/i18n/
COPY packages/cli/package.json packages/cli/
COPY apps/api/package.json apps/api/
COPY integrations/ integrations/
RUN pnpm install --frozen-lockfile

# Install production dependencies only (for runtime)
FROM base AS prod-deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/shared-mobility/package.json packages/shared-mobility/
COPY packages/mobility-formats/package.json packages/mobility-formats/
COPY packages/hey-api-client-fetch/package.json packages/hey-api-client-fetch/
COPY packages/i18n/package.json packages/i18n/
COPY packages/cli/package.json packages/cli/
COPY apps/api/package.json apps/api/
COPY integrations/ integrations/
RUN pnpm install --frozen-lockfile --prod --ignore-scripts && \
    cd node_modules/.pnpm && \
    rm -rf next@* @next+swc* prisma@* @prisma+* sharp@* @img+sharp* \
           @electric-sql+pglite* @rolldown+binding* \
           lightningcss* drizzle-kit@* effect@* typescript@*
# Note: esbuild and @esbuild/* are kept because tsx pulls esbuild at runtime
# to strip TypeScript types on-the-fly during dynamic integration imports.

# Build (type-check + bundle)
FROM base AS builder
WORKDIR /app

COPY --from=deps /app ./

COPY packages/core/ packages/core/
COPY packages/shared-mobility/ packages/shared-mobility/
COPY packages/mobility-formats/ packages/mobility-formats/
COPY packages/hey-api-client-fetch/ packages/hey-api-client-fetch/
COPY apps/api/ apps/api/
COPY turbo.json ./

WORKDIR /app/apps/api
RUN pnpm build

# Production image
FROM node:24-alpine AS runner
WORKDIR /app

# curl is required by the container healthcheck (generated from
# services/app-api/service.json — docker compose healthcheck runs
# `curl -fs http://localhost:3001/health`). Alpine ships wget but not curl,
# so we install it explicitly. ca-certificates gives node outgoing HTTPS.
#
# git is required by admin Store / community-service repository installs:
# both the community integration installer and service-repo refresh path clone
# or fetch allowlisted Git URLs from inside the app-api container.
#
# docker-cli + docker-cli-compose enable the admin GUI's service-lifecycle
# and data-maintenance workflows: admin-ops.ts and admin-cli.ts shell out to
# `docker compose -f <generated>.yml up/stop/restart` and to `openmapx ...`.
# The socket itself is mounted via services/app-api/service.json's
# `@docker-socket` bindMount. Without the CLI in the image those handlers
# would fail even when the socket is available. Kept behind the same apk
# install for a single image layer.
RUN apk add --no-cache curl ca-certificates git docker-cli docker-cli-compose

ENV NODE_ENV=production
ENV PORT=3001
# findRepoRoot() walks up for pnpm-workspace.yaml/turbo.json — neither exists
# in the runner image. Short-circuit to /app (where apps/, packages/,
# integrations/ live, everything the runtime reads from the repo tree).
ENV OPENMAPX_ROOT_DIR=/app

# Root + API node_modules
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/apps/api/node_modules ./apps/api/node_modules

# Source packages needed at runtime by integration code. We need both the
# source .ts files (for tsx to load dynamically) AND each package's own
# node_modules (pnpm symlinks to its declared deps — Node resolves from the
# .ts file's location upward, so `@better-auth/passkey` imported from
# packages/core must be reachable via packages/core/node_modules).
COPY packages/core/ packages/core/
COPY packages/shared-mobility/ packages/shared-mobility/
COPY packages/mobility-formats/ packages/mobility-formats/
COPY packages/hey-api-client-fetch/ packages/hey-api-client-fetch/
COPY --from=prod-deps /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=prod-deps /app/packages/shared-mobility/node_modules ./packages/shared-mobility/node_modules
COPY --from=prod-deps /app/packages/mobility-formats/node_modules ./packages/mobility-formats/node_modules

# packages/cli source + node_modules are needed by admin-cli.ts, which spawns
# `node --experimental-strip-types packages/cli/src/index.ts <cmd>` for data
# jobs, backups, and service-lifecycle actions from the admin GUI. When the
# operator sets OPENMAPX_HOST_DIR the host repo's CLI takes precedence (via
# the bind mount), so these files are really the fallback for deployments
# that don't bind-mount the host tree. The CLI is tiny (no native deps) so
# the image-size cost is negligible.
COPY packages/cli/ packages/cli/
COPY --from=prod-deps /app/packages/cli/node_modules ./packages/cli/node_modules

# Integrations with pnpm-resolved node_modules (manifests + code + deps)
COPY --from=prod-deps /app/integrations ./integrations

# Service manifests are read at runtime by the API service registry. They are
# not needed for the bundle itself, but without them self-hosted containers
# cannot resolve integration `requires:` entries or render compose previews.
COPY services/ services/

# API build output
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/apps/api/src/db/migrations ./apps/api/dist/db/migrations
COPY apps/api/package.json ./apps/api/

# tsx resolves tsconfig paths + .js → .ts at runtime. We ship:
#   - apps/api/tsconfig.json: defines `@integrations/*` → `../../integrations/*`
#   - packages/core/tsconfig.json: same alias, resolved relative to packages/core
# These are needed because dist/server.js (bundled) dynamically loads:
#   - /app/integrations/<id>/index.ts — .ts, often imports from ./provider.js
#   - /app/packages/core/src/index.ts — imports `@integrations/poi-search/types`
COPY apps/api/tsconfig.json ./apps/api/
COPY packages/core/tsconfig.json ./packages/core/

WORKDIR /app/apps/api
EXPOSE 3001
# `--import tsx/esm` activates the tsx loader for all subsequent imports,
# including the dynamic integration loader's runtime imports of .ts files.
CMD ["node", "--import", "tsx/esm", "dist/server.js"]

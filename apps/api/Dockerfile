FROM node:24-alpine AS base
RUN corepack enable && corepack prepare pnpm@latest --activate

# Install all dependencies (for building)
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/core/package.json packages/core/
COPY packages/shared-mobility/package.json packages/shared-mobility/
COPY packages/i18n/package.json packages/i18n/
COPY apps/api/package.json apps/api/
COPY integrations/ integrations/
RUN pnpm install --frozen-lockfile

# Install production dependencies only (for runtime)
FROM base AS prod-deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/core/package.json packages/core/
COPY packages/shared-mobility/package.json packages/shared-mobility/
COPY packages/i18n/package.json packages/i18n/
COPY apps/api/package.json apps/api/
COPY integrations/ integrations/
RUN pnpm install --frozen-lockfile --prod --ignore-scripts && \
    cd node_modules/.pnpm && \
    rm -rf next@* @next+swc* prisma@* @prisma+* sharp@* @img+sharp* \
           @electric-sql+pglite* @rolldown+binding* esbuild@* @esbuild+* \
           lightningcss* drizzle-kit@* effect@* typescript@*

# Build (type-check + bundle)
FROM base AS builder
WORKDIR /app

COPY --from=deps /app ./

COPY packages/core/ packages/core/
COPY packages/shared-mobility/ packages/shared-mobility/
COPY apps/api/ apps/api/
COPY turbo.json ./

WORKDIR /app/apps/api
RUN pnpm build

# Production image
FROM node:24-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001
# findRepoRoot() walks up for pnpm-workspace.yaml/turbo.json — neither exists
# in the runner image. Short-circuit to /app (where apps/, packages/,
# integrations/ live, everything the runtime reads from the repo tree).
ENV OPENMAPX_ROOT_DIR=/app

# Root + API node_modules
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/apps/api/node_modules ./apps/api/node_modules

# Source packages needed at runtime by integration code
COPY packages/core/ packages/core/
COPY packages/shared-mobility/ packages/shared-mobility/

# Integrations with pnpm-resolved node_modules (manifests + code + deps)
COPY --from=prod-deps /app/integrations ./integrations

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

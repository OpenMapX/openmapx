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

WORKDIR /app/apps/api
EXPOSE 3001
CMD ["node", "dist/server.js"]

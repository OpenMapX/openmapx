FROM node:24-alpine AS base
RUN corepack enable && corepack prepare pnpm@latest --activate

# ── Install all dependencies (for building) ──────────────────────────────
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile

# ── Install production dependencies only (for runtime) ───────────────────
FROM base AS prod-deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --prod --ignore-scripts && \
    cd node_modules/.pnpm && \
    rm -rf next@* @next+swc* prisma@* @prisma+* sharp@* @img+sharp* \
           @electric-sql+pglite* @rolldown+binding* esbuild@* @esbuild+* \
           lightningcss* drizzle-kit@* effect@* typescript@*

# ── Build (type-check + bundle) ─────────────────────────────────────────
FROM base AS builder
WORKDIR /app

COPY --from=deps /app ./

COPY packages/core/ packages/core/
COPY apps/api/ apps/api/
COPY turbo.json ./

WORKDIR /app/apps/api
RUN pnpm build

# ── Production image ──────────────────────────────────────────────────────
FROM node:24-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY apps/api/package.json ./apps/api/

WORKDIR /app/apps/api
EXPOSE 3001
CMD ["node", "dist/server.js"]

FROM node:24-alpine AS base
RUN corepack enable && corepack prepare pnpm@latest --activate

# ── Install dependencies ──────────────────────────────────────────────────
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/config/package.json packages/config/
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile

# ── Build (type-check) ────────────────────────────────────────────────────
FROM base AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/config/node_modules ./packages/config/node_modules
COPY --from=deps /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules

COPY package.json pnpm-workspace.yaml turbo.json ./
COPY packages/config/ packages/config/
COPY packages/core/ packages/core/
COPY apps/api/ apps/api/

RUN cd apps/api && npx tsc --noEmit

# ── Production image ──────────────────────────────────────────────────────
FROM base AS runner
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/config/node_modules ./packages/config/node_modules
COPY --from=deps /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules

COPY package.json pnpm-workspace.yaml ./
COPY packages/config/ packages/config/
COPY packages/core/src packages/core/src
COPY packages/core/package.json packages/core/
COPY packages/core/tsconfig.json packages/core/
COPY apps/api/src apps/api/src
COPY apps/api/package.json apps/api/
COPY apps/api/tsconfig.json apps/api/

ENV NODE_ENV=production
WORKDIR /app/apps/api
EXPOSE 3001
CMD ["node", "--import", "tsx/esm", "src/server.ts"]

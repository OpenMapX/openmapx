FROM node:24-alpine AS base
RUN corepack enable && corepack prepare pnpm@latest --activate

# ── Install dependencies ──────────────────────────────────────────────────
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/config/package.json packages/config/
COPY packages/core/package.json packages/core/
COPY packages/map-styles/package.json packages/map-styles/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

# ── Build ─────────────────────────────────────────────────────────────────
FROM base AS builder
RUN apk add --no-cache rsync
WORKDIR /app

COPY --from=deps /app ./

COPY packages/config/ packages/config/
COPY packages/core/ packages/core/
COPY apps/web/ apps/web/
COPY turbo.json ./

ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_MAPTILER_KEY
ARG NEXT_PUBLIC_MAPILLARY_TOKEN
ARG NEXT_PUBLIC_MAP_STYLE_URL

ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
ENV NEXT_PUBLIC_MAPTILER_KEY=${NEXT_PUBLIC_MAPTILER_KEY}
ENV NEXT_PUBLIC_MAPILLARY_TOKEN=${NEXT_PUBLIC_MAPILLARY_TOKEN}
ENV NEXT_PUBLIC_MAP_STYLE_URL=${NEXT_PUBLIC_MAP_STYLE_URL}
ENV NEXT_TELEMETRY_DISABLED=1

WORKDIR /app/apps/web
RUN pnpm build

# ── Production image ──────────────────────────────────────────────────────
FROM node:24-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/public ./apps/web/public

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
CMD ["node", "apps/web/server.js"]

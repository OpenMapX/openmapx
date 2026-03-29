FROM node:24-alpine AS base
RUN corepack enable && corepack prepare pnpm@latest --activate

# ── Install dependencies ──────────────────────────────────────────────────
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/i18n/package.json packages/i18n/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

# ── Build ─────────────────────────────────────────────────────────────────
FROM base AS builder
RUN apk add --no-cache rsync
WORKDIR /app

COPY --from=deps /app ./

COPY packages/core/ packages/core/
COPY packages/i18n/ packages/i18n/
COPY apps/web/ apps/web/
COPY turbo.json ./

# Build with placeholders — replaced at runtime by docker-entrypoint.sh
ENV NEXT_PUBLIC_API_URL=__NEXT_PUBLIC_API_URL__
ENV NEXT_PUBLIC_MAPTILER_KEY=__NEXT_PUBLIC_MAPTILER_KEY__
ENV NEXT_PUBLIC_MAPILLARY_TOKEN=__NEXT_PUBLIC_MAPILLARY_TOKEN__
ENV NEXT_PUBLIC_MAP_STYLE_URL=__NEXT_PUBLIC_MAP_STYLE_URL__
ENV NEXT_PUBLIC_TILES_URL=__NEXT_PUBLIC_TILES_URL__
ENV NEXT_PUBLIC_STYLE_PROVIDER=__NEXT_PUBLIC_STYLE_PROVIDER__
ENV NEXT_PUBLIC_TRAFFIC_MIN_ZOOM=__NEXT_PUBLIC_TRAFFIC_MIN_ZOOM__
ENV NEXT_PUBLIC_TRAFFIC_TILE_URL_TEMPLATE=__NEXT_PUBLIC_TRAFFIC_TILE_URL_TEMPLATE__
ENV NEXT_PUBLIC_CYCLOSM_TILE_URL_TEMPLATE=__NEXT_PUBLIC_CYCLOSM_TILE_URL_TEMPLATE__
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
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["node", "apps/web/server.js"]

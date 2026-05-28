FROM node:24-alpine AS base
# Read the pnpm version directly from the repo root package.json to ensure
# lockfile resolution stays reproducible across local and CI Docker builds.
COPY package.json /tmp/package.json
RUN corepack enable && corepack prepare $(node -e "console.log(require('/tmp/package.json').packageManager)") --activate

# Install dependencies
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/command-palette/package.json packages/command-palette/
COPY packages/core/package.json packages/core/
COPY packages/i18n/package.json packages/i18n/
COPY packages/integration-framework/package.json packages/integration-framework/
COPY packages/mangrove-client/package.json packages/mangrove-client/
COPY packages/mangrove-react/package.json packages/mangrove-react/
COPY packages/mobility-core/package.json packages/mobility-core/
COPY packages/mobility-formats/package.json packages/mobility-formats/
COPY packages/noaa-coops-data/package.json packages/noaa-coops-data/
COPY packages/ourairports-data/package.json packages/ourairports-data/
COPY packages/place-ids/package.json packages/place-ids/
COPY packages/poi-source-registry/package.json packages/poi-source-registry/
COPY packages/presets/package.json packages/presets/
COPY apps/web/package.json apps/web/
COPY integrations/ integrations/
RUN pnpm install --frozen-lockfile

# Build
FROM base AS builder
WORKDIR /app

COPY --from=deps /app ./

COPY packages/command-palette/ packages/command-palette/
COPY packages/core/ packages/core/
COPY packages/i18n/ packages/i18n/
COPY packages/integration-framework/ packages/integration-framework/
COPY packages/mangrove-client/ packages/mangrove-client/
COPY packages/mangrove-react/ packages/mangrove-react/
COPY packages/mobility-core/ packages/mobility-core/
COPY packages/mobility-formats/ packages/mobility-formats/
COPY packages/noaa-coops-data/ packages/noaa-coops-data/
COPY packages/ourairports-data/ packages/ourairports-data/
COPY packages/place-ids/ packages/place-ids/
COPY packages/poi-source-registry/ packages/poi-source-registry/
COPY packages/presets/ packages/presets/
COPY integrations/ integrations/
COPY apps/web/ apps/web/
COPY tsconfig.base.json ./
COPY turbo.json ./

# Placeholder for packages/core which reads process.env.NEXT_PUBLIC_API_URL
# directly (inlined at build time). Replaced at runtime by docker-entrypoint.sh.
# All other NEXT_PUBLIC_* vars are provided via the EnvProvider React context
# (built server-side from real process.env at request time) and need no placeholders.
ENV NEXT_PUBLIC_API_URL=__NEXT_PUBLIC_API_URL__
ENV NEXT_TELEMETRY_DISABLED=1

WORKDIR /app/apps/web
RUN pnpm build

# Production image
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

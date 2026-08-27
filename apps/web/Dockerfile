FROM node:24-alpine@sha256:f70403e87646dc51b45295f4b8b70cdad0b63d2297c4c9899119b03f7af7a6b3 AS base
# Read the pnpm version directly from the repo root package.json to ensure
# lockfile resolution stays reproducible across local and CI Docker builds.
COPY package.json /tmp/package.json
RUN corepack enable && corepack prepare "$(node -e "console.log(require('/tmp/package.json').packageManager)")" --activate

# Install dependencies
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/command-palette/package.json packages/command-palette/
COPY packages/core/package.json packages/core/
COPY packages/hey-api-client-fetch/package.json packages/hey-api-client-fetch/
COPY packages/i18n/package.json packages/i18n/
COPY packages/integration-framework/package.json packages/integration-framework/
COPY packages/mangrove-client/package.json packages/mangrove-client/
COPY packages/mangrove-react/package.json packages/mangrove-react/
COPY packages/mobility-core/package.json packages/mobility-core/
COPY packages/ev-charge-planner/package.json packages/ev-charge-planner/
COPY packages/mobility-formats/package.json packages/mobility-formats/
COPY packages/noaa-coops-data/package.json packages/noaa-coops-data/
COPY packages/openconditions-contrib-client/package.json packages/openconditions-contrib-client/
COPY packages/ourairports-data/package.json packages/ourairports-data/
COPY packages/place-ids/package.json packages/place-ids/
COPY packages/poi-source-registry/package.json packages/poi-source-registry/
COPY packages/presets/package.json packages/presets/
COPY packages/brands/package.json packages/brands/
COPY packages/transitous-core/package.json packages/transitous-core/
COPY apps/web/package.json apps/web/
COPY integrations/ integrations/
RUN pnpm install --frozen-lockfile

# Build
FROM base AS builder
WORKDIR /app

COPY --from=deps /app ./

COPY packages/command-palette/ packages/command-palette/
COPY packages/core/ packages/core/
COPY packages/hey-api-client-fetch/ packages/hey-api-client-fetch/
COPY packages/i18n/ packages/i18n/
COPY packages/integration-framework/ packages/integration-framework/
COPY packages/mangrove-client/ packages/mangrove-client/
COPY packages/mangrove-react/ packages/mangrove-react/
COPY packages/mobility-core/ packages/mobility-core/
COPY packages/ev-charge-planner/ packages/ev-charge-planner/
COPY packages/mobility-formats/ packages/mobility-formats/
COPY packages/noaa-coops-data/ packages/noaa-coops-data/
COPY packages/openconditions-contrib-client/ packages/openconditions-contrib-client/
COPY packages/ourairports-data/ packages/ourairports-data/
COPY packages/place-ids/ packages/place-ids/
COPY packages/poi-source-registry/ packages/poi-source-registry/
COPY packages/presets/ packages/presets/
COPY packages/brands/ packages/brands/
COPY packages/transitous-core/ packages/transitous-core/
COPY integrations/ integrations/
COPY apps/web/ apps/web/
# The service-worker cache contract is type-checked by Next and verifies its
# public allowlist against the committed API authority document.
COPY apps/api/openapi.json apps/api/openapi.json
COPY tsconfig.base.json ./
COPY turbo.json ./

# Placeholder for packages/core which reads process.env.NEXT_PUBLIC_API_URL
# directly (inlined at build time). Replaced at runtime by docker-entrypoint.sh.
# All other NEXT_PUBLIC_* vars are provided via the EnvProvider React context
# (built server-side from real process.env at request time) and need no placeholders.
ENV NEXT_PUBLIC_API_URL=__NEXT_PUBLIC_API_URL__
ENV NEXT_TELEMETRY_DISABLED=1

WORKDIR /app/apps/web
# Per-build service-worker id (CI passes the git SHA). Declared right before the
# build so a new value busts this layer's cache and `build:sw` re-stamps sw.js,
# letting the PWA detect the update. Defaults to empty for plain `docker build`,
# in which case build-sw.mjs falls back to the git SHA / a timestamp.
ARG SW_BUILD_ID=
ENV SW_BUILD_ID=$SW_BUILD_ID
RUN pnpm build

# Production image
FROM node:24-alpine@sha256:f70403e87646dc51b45295f4b8b70cdad0b63d2297c4c9899119b03f7af7a6b3 AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# The pinned base predates Alpine's OpenSSL fix for CVE-2026-14456.
RUN apk upgrade --no-cache libcrypto3 libssl3 && \
    addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs && \
    rm -rf /usr/local/lib/node_modules/npm && \
    rm -f /usr/local/bin/npm /usr/local/bin/npx

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

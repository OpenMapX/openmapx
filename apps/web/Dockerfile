FROM node:24-alpine AS base
RUN corepack enable && corepack prepare pnpm@latest --activate

# Install dependencies
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/core/package.json packages/core/
COPY packages/i18n/package.json packages/i18n/
COPY apps/web/package.json apps/web/
COPY integrations/ integrations/
RUN pnpm install --frozen-lockfile

# Build
FROM base AS builder
RUN apk add --no-cache rsync
WORKDIR /app

COPY --from=deps /app ./

COPY packages/core/ packages/core/
COPY packages/i18n/ packages/i18n/
COPY integrations/ integrations/
COPY apps/web/ apps/web/
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

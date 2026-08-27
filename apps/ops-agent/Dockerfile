# syntax=docker/dockerfile:1.7

FROM node:24-alpine@sha256:f70403e87646dc51b45295f4b8b70cdad0b63d2297c4c9899119b03f7af7a6b3 AS base
COPY package.json /tmp/package.json
RUN corepack enable && corepack prepare "$(node -e "console.log(require('/tmp/package.json').packageManager)")" --activate

FROM base AS deps
WORKDIR /app
ENV HUSKY=0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/ packages/
COPY apps/ops-agent/package.json apps/ops-agent/
RUN pnpm install --frozen-lockfile

FROM base AS prod-deps
WORKDIR /app
ENV HUSKY=0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/ packages/
COPY apps/ops-agent/package.json apps/ops-agent/
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

FROM deps AS builder
WORKDIR /app
COPY packages/core/ packages/core/
COPY apps/ops-agent/ apps/ops-agent/
COPY tsconfig.base.json ./
WORKDIR /app/apps/ops-agent
RUN pnpm build

FROM base AS runner
WORKDIR /app
RUN apk add --no-cache ca-certificates curl docker-cli docker-cli-compose && \
    rm -rf /usr/local/lib/node_modules/npm && \
    rm -f /usr/local/bin/npm /usr/local/bin/npx

ENV NODE_ENV=production
ENV HOME=/home/node
ENV PORT=4300

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/apps/ops-agent/node_modules ./apps/ops-agent/node_modules
COPY --from=prod-deps /app/packages/ ./packages/
COPY packages/ ./packages/
COPY --from=builder /app/apps/ops-agent/dist ./apps/ops-agent/dist
COPY apps/ops-agent/package.json ./apps/ops-agent/
COPY services/ ./services/
COPY pnpm-workspace.yaml tsconfig.base.json ./

RUN chown -R node:node /app /home/node
USER node:node

WORKDIR /app/apps/ops-agent
EXPOSE 4300
HEALTHCHECK --interval=15s --timeout=3s --retries=5 CMD ["curl", "-fsS", "http://127.0.0.1:4300/health"]
CMD ["node", "--import", "tsx/esm", "dist/index.js"]

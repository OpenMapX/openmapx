FROM node:24-slim AS base

# Keep this pinned to the repo root `packageManager` field so Docker resolves
# dependencies with the same pnpm version that generated pnpm-lock.yaml.
ARG PNPM_VERSION=9.15.9
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

FROM base AS deps
WORKDIR /app
ENV HUSKY=0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY services/data-manager/package.json services/data-manager/

RUN pnpm install --filter @openmapx/data-manager... --frozen-lockfile

FROM base AS prod-deps
WORKDIR /app
ENV HUSKY=0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY services/data-manager/package.json services/data-manager/

RUN pnpm install --filter @openmapx/data-manager... --frozen-lockfile --prod --ignore-scripts

FROM deps AS builder
WORKDIR /app

COPY services/data-manager/ services/data-manager/

WORKDIR /app/services/data-manager
RUN pnpm build

FROM node:24-slim AS runner
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends osmium-tool curl unzip bzip2 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/services/data-manager/node_modules ./services/data-manager/node_modules
COPY --from=builder /app/services/data-manager/dist ./services/data-manager/dist
COPY services/data-manager/package.json ./services/data-manager/

WORKDIR /app/services/data-manager
EXPOSE 4000
CMD ["node", "dist/index.js"]

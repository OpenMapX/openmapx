# syntax=docker/dockerfile:1.7
#
# IMPORTANT: build context MUST be the repo root. This Dockerfile reaches
# outside its own directory to pick up:
#   - pnpm-workspace.yaml + workspace package.json files (for dependency
#     resolution of @openmapx/hardlinks)
#   - services/motis/tools/transitous/requirements.txt (pulled into the
#     runtime stage for the Transitous GTFS pipeline)
#
# Build command (from repo root):
#   docker build -t openmapx-data-manager -f services/data-manager/Dockerfile .
#
# The GitHub Actions workflow at .github/workflows/docker.yml builds this
# image with `context: .` for the same reason.

FROM docker.io/golang:1.26 AS build-gtfsclean
RUN GOPROXY=direct GOBIN=/usr/local/bin/ go install github.com/public-transport/gtfsclean@latest

FROM node:24-slim AS base

# Read the pnpm version directly from the repo root package.json to ensure
# lockfile resolution stays reproducible across local and CI Docker builds.
COPY package.json /tmp/package.json
RUN corepack enable && corepack prepare $(node -e "console.log(require('/tmp/package.json').packageManager)") --activate

FROM base AS deps
WORKDIR /app
ENV HUSKY=0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY services/data-manager/package.json services/data-manager/
COPY packages/hardlinks/package.json packages/hardlinks/

RUN pnpm install --filter @openmapx/data-manager --frozen-lockfile

FROM base AS prod-deps
WORKDIR /app
ENV HUSKY=0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY services/data-manager/package.json services/data-manager/
COPY packages/hardlinks/package.json packages/hardlinks/

RUN pnpm install --filter @openmapx/data-manager --frozen-lockfile --prod --ignore-scripts

FROM deps AS builder
WORKDIR /app

COPY packages/hardlinks/ packages/hardlinks/
COPY services/data-manager/ services/data-manager/

WORKDIR /app/services/data-manager
RUN pnpm build

FROM node:24-slim AS runner
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      osmium-tool curl unzip bzip2 ca-certificates age \
      git python3 python3-pip python3-venv wget rsync openssh-client \
    && rm -rf /var/lib/apt/lists/*
RUN rm -f /usr/lib/python3.*/EXTERNALLY-MANAGED
COPY services/motis/tools/transitous/requirements.txt /tmp/transitous-requirements.txt
RUN pip3 install --no-cache-dir -r /tmp/transitous-requirements.txt
COPY --from=build-gtfsclean /usr/local/bin/gtfsclean /usr/local/bin/gtfsclean

ENV NODE_ENV=production
ENV PYTHONDONTWRITEBYTECODE=1

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/services/data-manager/node_modules ./services/data-manager/node_modules
# The shared @openmapx/hardlinks package ships its TypeScript source directly;
# tsx/esm (preserved because it's a prod dep) transpiles it on import. This
# matches how apps/api loads its dynamic integration code.
COPY packages/hardlinks/ ./packages/hardlinks/
COPY --from=builder /app/services/data-manager/dist ./services/data-manager/dist
COPY services/data-manager/package.json ./services/data-manager/

# Run as a dedicated non-root user. The data-manager writes to /data which is
# bind-mounted from the host — the host-side permissions need to allow writes
# by UID/GID 1001, or operators can override via `docker run --user` /
# compose `user:`. node:24-slim ships a "node" user at UID 1000 we could reuse,
# but the 1001 UID aligns with conventions used by the rest of the project's
# service images and avoids colliding with host user IDs.
RUN groupadd --system --gid 1001 datamgr \
    && useradd --system --uid 1001 --gid datamgr --create-home --home-dir /home/datamgr datamgr \
    && chown -R datamgr:datamgr /app /home/datamgr

USER datamgr:datamgr

WORKDIR /app/services/data-manager
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD curl -fs http://localhost:4000/status || exit 1
# `--import tsx/esm` lets the compiled dist/index.js reach back into
# @openmapx/hardlinks's .ts source without a separate build step.
CMD ["node", "--import", "tsx/esm", "dist/index.js"]

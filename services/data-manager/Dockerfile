# syntax=docker/dockerfile:1.7
#
# IMPORTANT: build context MUST be the repo root. This Dockerfile reaches
# outside its own directory to pick up:
#   - pnpm-workspace.yaml + workspace package.json files (for dependency
#     resolution of @openmapx/db-schema, @openmapx/hardlinks, and
#     @openmapx/motis-feed-proxy-config)
#   - services/motis/tools/transitous/requirements.txt (pulled into the
#     runtime stage for the Transitous GTFS pipeline)
#
# Build command (from repo root):
#   docker build -t openmapx-data-manager -f services/data-manager/Dockerfile .
#
# The GitHub Actions workflow at .github/workflows/docker.yml builds this
# image with `context: .` for the same reason.

FROM docker.io/golang:1.26@sha256:f96cc555eb8db430159a3aa6797cd5bae561945b7b0fe7d0e284c63a3b291609 AS build-gtfsclean
# Pin gtfsclean to a commit (the project only publishes rolling snapshot-N tags)
# instead of @latest so the build is reproducible and can't silently pull new code.
RUN GOPROXY=direct GOBIN=/usr/local/bin/ go install github.com/public-transport/gtfsclean@bb3ea74f66ef9bc07dc1bd038c3f653e10f0ade0 # snapshot-5

FROM node:24-slim@sha256:b31e7a42fdf8b8aa5f5ed477c72d694301273f1069c5a2f71d53c6482e99a2fc AS base

# Read the pnpm version directly from the repo root package.json to ensure
# lockfile resolution stays reproducible across local and CI Docker builds.
COPY package.json /tmp/package.json
RUN corepack enable && corepack prepare $(node -e "console.log(require('/tmp/package.json').packageManager)") --activate

FROM base AS deps
WORKDIR /app
ENV HUSKY=0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY services/data-manager/package.json services/data-manager/
COPY packages/db-schema/package.json packages/db-schema/
COPY packages/hardlinks/package.json packages/hardlinks/
COPY packages/motis-feed-proxy-config/package.json packages/motis-feed-proxy-config/
COPY packages/mobility-formats/package.json packages/mobility-formats/
COPY packages/poi-source-registry/package.json packages/poi-source-registry/
COPY packages/transitous-core/package.json packages/transitous-core/
COPY packages/core/package.json packages/core/

RUN pnpm install --filter @openmapx/data-manager... --frozen-lockfile

FROM base AS prod-deps
WORKDIR /app
ENV HUSKY=0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY services/data-manager/package.json services/data-manager/
COPY packages/db-schema/package.json packages/db-schema/
COPY packages/hardlinks/package.json packages/hardlinks/
COPY packages/motis-feed-proxy-config/package.json packages/motis-feed-proxy-config/
COPY packages/mobility-formats/package.json packages/mobility-formats/
COPY packages/poi-source-registry/package.json packages/poi-source-registry/
COPY packages/transitous-core/package.json packages/transitous-core/
COPY packages/core/package.json packages/core/

RUN pnpm install --filter @openmapx/data-manager... --frozen-lockfile --prod --ignore-scripts

FROM deps AS builder
WORKDIR /app

COPY tsconfig.base.json ./
COPY packages/db-schema/ packages/db-schema/
COPY packages/hardlinks/ packages/hardlinks/
COPY packages/motis-feed-proxy-config/ packages/motis-feed-proxy-config/
COPY packages/mobility-formats/ packages/mobility-formats/
COPY packages/poi-source-registry/ packages/poi-source-registry/
COPY packages/transitous-core/ packages/transitous-core/
COPY packages/core/ packages/core/
COPY services/data-manager/ services/data-manager/

WORKDIR /app/services/data-manager
RUN pnpm build

FROM node:24-slim@sha256:b31e7a42fdf8b8aa5f5ed477c72d694301273f1069c5a2f71d53c6482e99a2fc AS runner
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      osmium-tool curl unzip bzip2 ca-certificates age \
      git python3 python3-pip python3-venv wget rsync openssh-client \
    && rm -rf /var/lib/apt/lists/*

# Static Docker CLI so the data-manager can invoke `docker exec` (feed-proxy
# nginx reload, motis-staging import) and `docker restart` (atomic-swap promote)
# against the host daemon via the bind-mounted socket. We pull the static
# binary tarball instead of `docker.io`/`docker-ce-cli` to avoid dragging in
# the daemon, systemd units, or third-party apt repos. Pin to a recent stable
# release; the CLI is forward/backward-compatible with daemons within a few
# minor versions.
ARG DOCKER_CLI_VERSION=27.5.1
RUN set -eux; \
    arch="$(uname -m)"; \
    case "$arch" in \
      x86_64) docker_arch=x86_64 ;; \
      aarch64|arm64) docker_arch=aarch64 ;; \
      *) echo "Unsupported arch $arch for Docker CLI install" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://download.docker.com/linux/static/stable/${docker_arch}/docker-${DOCKER_CLI_VERSION}.tgz" -o /tmp/docker.tgz; \
    tar -xzf /tmp/docker.tgz -C /tmp; \
    mv /tmp/docker/docker /usr/local/bin/docker; \
    chmod +x /usr/local/bin/docker; \
    rm -rf /tmp/docker /tmp/docker.tgz; \
    docker --version
ARG DUCKDB_VERSION=1.3.1
RUN set -eux; \
    arch="$(uname -m)"; \
    case "$arch" in \
      x86_64)          duckdb_arch=linux-amd64 ;; \
      aarch64|arm64)   duckdb_arch=linux-arm64 ;; \
      *) echo "Unsupported arch $arch for DuckDB CLI install" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/duckdb/duckdb/releases/download/v${DUCKDB_VERSION}/duckdb_cli-${duckdb_arch}.zip" -o /tmp/duckdb.zip; \
    unzip /tmp/duckdb.zip -d /tmp/duckdb-bin; \
    mv /tmp/duckdb-bin/duckdb /usr/local/bin/duckdb; \
    chmod +x /usr/local/bin/duckdb; \
    rm -rf /tmp/duckdb.zip /tmp/duckdb-bin; \
    duckdb --version
RUN rm -f /usr/lib/python3.*/EXTERNALLY-MANAGED
COPY services/motis/tools/transitous/requirements.txt /tmp/transitous-requirements.txt
RUN pip3 install --no-cache-dir -r /tmp/transitous-requirements.txt
COPY --from=build-gtfsclean /usr/local/bin/gtfsclean /usr/local/bin/gtfsclean

ENV NODE_ENV=production
ENV PYTHONDONTWRITEBYTECODE=1

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/services/data-manager/node_modules ./services/data-manager/node_modules
# The shared @openmapx/db-schema, @openmapx/hardlinks, and
# @openmapx/motis-feed-proxy-config packages ship their TypeScript source
# directly; tsx/esm (preserved because it's a prod dep) transpiles them on
# import. This matches how apps/api loads its dynamic integration code.
# db-schema needs its own node_modules so the symlinked drizzle-orm resolves
# from its source files at runtime; the other two have no prod externals so
# only the source is needed.
COPY packages/db-schema/ ./packages/db-schema/
COPY --from=prod-deps /app/packages/db-schema/node_modules ./packages/db-schema/node_modules
COPY packages/hardlinks/ ./packages/hardlinks/
COPY packages/motis-feed-proxy-config/ ./packages/motis-feed-proxy-config/
COPY packages/mobility-formats/ ./packages/mobility-formats/
COPY --from=prod-deps /app/packages/mobility-formats/node_modules ./packages/mobility-formats/node_modules
COPY packages/poi-source-registry/ ./packages/poi-source-registry/
COPY packages/transitous-core/ ./packages/transitous-core/
COPY --from=prod-deps /app/packages/transitous-core/node_modules ./packages/transitous-core/node_modules
COPY packages/core/ ./packages/core/
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
# `--import tsx/esm` lets the compiled dist entry reach back into
# @openmapx/db-schema's, @openmapx/hardlinks's, and
# @openmapx/motis-feed-proxy-config's .ts source without a separate build step.
CMD ["node", "--import", "tsx/esm", "dist/index.js"]

# syntax=docker/dockerfile:1.19
#
# IMPORTANT: build context MUST be the repo root. This Dockerfile reaches
# outside its own directory to pick up:
#   - pnpm-workspace.yaml + workspace package.json files (for dependency
#     resolution of @openmapx/db-schema, @openmapx/hardlinks, and the other
#     workspace packages the baked `integrations/` tree depends on)
#   - integrations/ — baked into the image so POI-source discovery is
#     self-contained (see poi-source-discovery.ts): no host bind-mount of
#     the repo is required to see integration code, mirroring apps/api
#   - services/motis/tools/transitous/requirements.txt (pulled into the
#     runtime stage for the Transitous GTFS pipeline)
#
# Build command (from repo root):
#   docker build -t openmapx-data-manager -f services/data-manager/Dockerfile .
#
# The GitHub Actions workflow at .github/workflows/docker.yml builds this
# image with `context: .` for the same reason.

FROM docker.io/golang:1.27@sha256:4013ae0f9e7994f8535c58c811f8f863fbed38b72e0d51e6592156f758d66146 AS build-gtfsclean
# Pin gtfsclean to a commit (the project only publishes rolling snapshot-N tags)
# instead of @latest so the build is reproducible and can't silently pull new code.
WORKDIR /tmp/gtfsclean-build
RUN GOPROXY=direct go mod init openmapx.local/gtfsclean-build && \
    GOPROXY=direct go get github.com/public-transport/gtfsclean@bb3ea74f66ef9bc07dc1bd038c3f653e10f0ade0 && \
    GOPROXY=direct go get golang.org/x/text@v0.39.0 && \
    GOPROXY=direct go get golang.org/x/crypto@v0.55.0 && \
    GOPROXY=direct go build -trimpath -o /usr/local/bin/gtfsclean github.com/public-transport/gtfsclean

FROM node:24-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS base

# Read the pnpm version directly from the repo root package.json to ensure
# lockfile resolution stays reproducible across local and CI Docker builds.
COPY package.json /tmp/package.json
RUN corepack enable && corepack prepare "$(node -e "console.log(require('/tmp/package.json').packageManager)")" --activate

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
COPY packages/hey-api-client-fetch/package.json packages/hey-api-client-fetch/
COPY packages/i18n/package.json packages/i18n/
COPY packages/cli/package.json packages/cli/
COPY packages/air-quality/package.json packages/air-quality/
COPY packages/integration-framework/package.json packages/integration-framework/
COPY packages/mangrove-client/package.json packages/mangrove-client/
COPY packages/mobility-core/package.json packages/mobility-core/
COPY packages/ev-charge-planner/package.json packages/ev-charge-planner/
COPY packages/noaa-coops-data/package.json packages/noaa-coops-data/
COPY packages/openconditions-contrib-client/package.json packages/openconditions-contrib-client/
COPY packages/ourairports-data/package.json packages/ourairports-data/
COPY packages/place-ids/package.json packages/place-ids/
COPY packages/presets/package.json packages/presets/
COPY packages/brands/package.json packages/brands/
COPY integrations/ integrations/

RUN pnpm install --frozen-lockfile

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
COPY packages/hey-api-client-fetch/package.json packages/hey-api-client-fetch/
COPY packages/i18n/package.json packages/i18n/
COPY packages/cli/package.json packages/cli/
COPY packages/air-quality/package.json packages/air-quality/
COPY packages/integration-framework/package.json packages/integration-framework/
COPY packages/mangrove-client/package.json packages/mangrove-client/
COPY packages/mobility-core/package.json packages/mobility-core/
COPY packages/ev-charge-planner/package.json packages/ev-charge-planner/
COPY packages/noaa-coops-data/package.json packages/noaa-coops-data/
COPY packages/openconditions-contrib-client/package.json packages/openconditions-contrib-client/
COPY packages/ourairports-data/package.json packages/ourairports-data/
COPY packages/place-ids/package.json packages/place-ids/
COPY packages/presets/package.json packages/presets/
COPY packages/brands/package.json packages/brands/
COPY integrations/ integrations/

RUN pnpm install --frozen-lockfile --prod --ignore-scripts && \
    rm -rf node_modules/.pnpm/image-size@*
# image-size belongs to Metro's mobile build toolchain, not the data-manager
# runtime. Do not copy that unused, currently vulnerable package into the
# production image merely because pnpm uses a shared workspace virtual store.

FROM deps AS builder
WORKDIR /app

COPY tsconfig.base.json ./
COPY --exclude=*/package.json packages/ packages/
COPY services/data-manager/ services/data-manager/

WORKDIR /app/services/data-manager
RUN pnpm build

FROM node:24-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS runner
WORKDIR /app
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# libexpat1 is named explicitly because the packages that pull it in are
# satisfied by the base image's older build, which predates the fix for
# CVE-2026-56408.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      osmium-tool curl unzip bzip2 ca-certificates age \
      git python3 python3-pip python3-venv wget rsync openssh-client \
      libexpat1 \
    && rm -rf /var/lib/apt/lists/*

# Static Docker CLI so the data-manager can invoke `docker exec` (feed-proxy
# nginx reload, motis-staging import) and `docker restart` (atomic-swap promote)
# against the host daemon via the bind-mounted socket. We pull the static
# binary tarball instead of `docker.io`/`docker-ce-cli` to avoid dragging in
# the daemon, systemd units, or third-party apt repos. Pin to a recent stable
# release; the CLI is forward/backward-compatible with daemons within a few
# minor versions.
ARG DOCKER_CLI_VERSION=29.7.2
ARG DOCKER_CLI_SHA256_AMD64=803d433f226db4776e1768fd319fc6c6e4935a456acf84fcc0080818b854bc8f
ARG DOCKER_CLI_SHA256_ARM64=43d143448adf2c2787704e7d7704fd6d62d367a54c5edaef0a3f75509cb0938d
RUN set -eux; \
    arch="$(uname -m)"; \
    case "$arch" in \
      x86_64) docker_arch=x86_64; expected_sha="$DOCKER_CLI_SHA256_AMD64" ;; \
      aarch64|arm64) docker_arch=aarch64; expected_sha="$DOCKER_CLI_SHA256_ARM64" ;; \
      *) echo "Unsupported arch $arch for Docker CLI install" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://download.docker.com/linux/static/stable/${docker_arch}/docker-${DOCKER_CLI_VERSION}.tgz" -o /tmp/docker.tgz; \
    echo "${expected_sha}  /tmp/docker.tgz" | sha256sum -c -; \
    tar -xzf /tmp/docker.tgz -C /tmp; \
    mv /tmp/docker/docker /usr/local/bin/docker; \
    chmod +x /usr/local/bin/docker; \
    rm -rf /tmp/docker /tmp/docker.tgz; \
    docker --version
# Compose v2 CLI plugin. The atomic-swap promote recreates the MOTIS container
# with `docker compose up -d --force-recreate` (a plain `docker restart` keeps
# the pre-swap bind-mount target), so the plugin — not just the base CLI — must
# be present, else promote fails with "unknown shorthand flag: 'f'".
ARG DOCKER_COMPOSE_VERSION=5.5.0
ARG DOCKER_COMPOSE_SHA256_AMD64=c57ab918abd5b05ca7e7d0f275875dd1330a695074f309dc9eab1b49efafcd4b
ARG DOCKER_COMPOSE_SHA256_ARM64=ff42489f5a9b879d5d117c5ffea6defc27390b3286da8ad52cbc9c6ab5df590e
RUN set -eux; \
    arch="$(uname -m)"; \
    case "$arch" in \
      x86_64) compose_arch=x86_64; expected_sha="$DOCKER_COMPOSE_SHA256_AMD64" ;; \
      aarch64|arm64) compose_arch=aarch64; expected_sha="$DOCKER_COMPOSE_SHA256_ARM64" ;; \
      *) echo "Unsupported arch $arch for Docker Compose install" >&2; exit 1 ;; \
    esac; \
    mkdir -p /usr/local/lib/docker/cli-plugins; \
    curl -fsSL "https://github.com/docker/compose/releases/download/v${DOCKER_COMPOSE_VERSION}/docker-compose-linux-${compose_arch}" \
      -o /usr/local/lib/docker/cli-plugins/docker-compose; \
    echo "${expected_sha}  /usr/local/lib/docker/cli-plugins/docker-compose" | sha256sum -c -; \
    chmod +x /usr/local/lib/docker/cli-plugins/docker-compose; \
    docker compose version
ARG DUCKDB_VERSION=1.3.1
ARG DUCKDB_SHA256_AMD64=a43e0156c9799496089dd265605113471df5a30a7db26e1c662484eb1d31fc08
ARG DUCKDB_SHA256_ARM64=93ddf7bc61d148273b821abbca911053dec3ba5e004d5fa981b4732b7e608905
RUN set -eux; \
    arch="$(uname -m)"; \
    case "$arch" in \
      x86_64) duckdb_arch=linux-amd64; expected_sha="$DUCKDB_SHA256_AMD64" ;; \
      aarch64|arm64) duckdb_arch=linux-arm64; expected_sha="$DUCKDB_SHA256_ARM64" ;; \
      *) echo "Unsupported arch $arch for DuckDB CLI install" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/duckdb/duckdb/releases/download/v${DUCKDB_VERSION}/duckdb_cli-${duckdb_arch}.zip" -o /tmp/duckdb.zip; \
    echo "${expected_sha}  /tmp/duckdb.zip" | sha256sum -c -; \
    unzip /tmp/duckdb.zip -d /tmp/duckdb-bin; \
    mv /tmp/duckdb-bin/duckdb /usr/local/bin/duckdb; \
    chmod +x /usr/local/bin/duckdb; \
    rm -rf /tmp/duckdb.zip /tmp/duckdb-bin; \
    duckdb --version
RUN rm -f /usr/lib/python3.*/EXTERNALLY-MANAGED
COPY services/motis/tools/transitous/requirements.txt /tmp/transitous-requirements.txt
RUN pip3 install --no-cache-dir --require-hashes -r /tmp/transitous-requirements.txt
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
COPY --from=prod-deps /app/packages/poi-source-registry/node_modules ./packages/poi-source-registry/node_modules
COPY packages/transitous-core/ ./packages/transitous-core/
COPY --from=prod-deps /app/packages/transitous-core/node_modules ./packages/transitous-core/node_modules
COPY packages/core/ ./packages/core/
COPY --from=prod-deps /app/packages/core/node_modules ./packages/core/node_modules
COPY packages/hey-api-client-fetch/ ./packages/hey-api-client-fetch/

# The baked `integrations/` tree (below) dynamically imports these packages
# at runtime the same way apps/api's integration loader does — they are not
# direct dependencies of @openmapx/data-manager itself, but of the
# integration code data-manager now ships and runs discovery against instead
# of reading from the host bind-mount.
COPY packages/place-ids/ ./packages/place-ids/
COPY packages/air-quality/ ./packages/air-quality/
COPY --from=prod-deps /app/packages/air-quality/node_modules ./packages/air-quality/node_modules
COPY packages/integration-framework/ ./packages/integration-framework/
COPY --from=prod-deps /app/packages/integration-framework/node_modules ./packages/integration-framework/node_modules
COPY packages/mobility-core/ ./packages/mobility-core/
COPY --from=prod-deps /app/packages/mobility-core/node_modules ./packages/mobility-core/node_modules
COPY packages/ev-charge-planner/ ./packages/ev-charge-planner/
COPY --from=prod-deps /app/packages/ev-charge-planner/node_modules ./packages/ev-charge-planner/node_modules
COPY packages/mangrove-client/ ./packages/mangrove-client/
COPY --from=prod-deps /app/packages/mangrove-client/node_modules ./packages/mangrove-client/node_modules
COPY packages/noaa-coops-data/ ./packages/noaa-coops-data/
COPY --from=prod-deps /app/packages/noaa-coops-data/node_modules ./packages/noaa-coops-data/node_modules
COPY packages/openconditions-contrib-client/ ./packages/openconditions-contrib-client/
COPY --from=prod-deps /app/packages/openconditions-contrib-client/node_modules ./packages/openconditions-contrib-client/node_modules
COPY packages/ourairports-data/ ./packages/ourairports-data/
COPY --from=prod-deps /app/packages/ourairports-data/node_modules ./packages/ourairports-data/node_modules
COPY packages/presets/ ./packages/presets/
COPY --from=prod-deps /app/packages/presets/node_modules ./packages/presets/node_modules
COPY packages/brands/ ./packages/brands/
COPY --from=prod-deps /app/packages/brands/node_modules ./packages/brands/node_modules

# packages/cli source + node_modules — bundled for parity with apps/api's
# runner (admin-cli.ts spawns the CLI for data jobs when no host bind-mount
# with the CLI is present); tiny, no native deps.
COPY packages/cli/ packages/cli/
COPY --from=prod-deps /app/packages/cli/node_modules ./packages/cli/node_modules

# Integrations with pnpm-resolved node_modules (manifests + code + deps) —
# this is what makes data-manager self-contained: POI-source discovery no
# longer needs the host bind-mount to see integration code.
COPY --from=prod-deps /app/integrations ./integrations

COPY --from=builder /app/services/data-manager/dist ./services/data-manager/dist
COPY services/data-manager/package.json ./services/data-manager/

# tsx resolves tsconfig paths + .js -> .ts at runtime for the dynamically
# imported integration modules (mirrors apps/api's runner).
ENV TSX_TSCONFIG_PATH=/app/tsconfig.base.json
COPY tsconfig.base.json ./

# Run as a dedicated non-root user. The data-manager writes to /data which is
# bind-mounted from the host — the host-side permissions need to allow writes
# by UID/GID 1001, or operators can override via `docker run --user` /
# compose `user:`. node:24-slim ships a "node" user at UID 1000 we could reuse,
# but the 1001 UID aligns with conventions used by the rest of the project's
# service images and avoids colliding with host user IDs.
RUN groupadd --system --gid 1001 datamgr \
    && useradd --system --uid 1001 --gid datamgr --create-home --home-dir /home/datamgr datamgr \
    && rm -rf /usr/local/lib/node_modules/npm \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx \
    && chown -R datamgr:datamgr /app /home/datamgr

USER datamgr:datamgr

WORKDIR /app/services/data-manager
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD ["curl", "-fs", "http://localhost:4000/status"]
# `--import tsx/esm` lets the compiled dist entry reach back into
# @openmapx/db-schema's, @openmapx/hardlinks's, and
# @openmapx/motis-feed-proxy-config's .ts source without a separate build step.
CMD ["node", "--import", "tsx/esm", "dist/index.js"]

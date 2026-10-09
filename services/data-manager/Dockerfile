# syntax=docker/dockerfile:1.19
#
# IMPORTANT: build context MUST be the repo root. This Dockerfile reaches
# outside its own directory to pick up:
#   - pnpm-workspace.yaml + workspace package.json files (for dependency
#     resolution of @openmapx/db-schema, @openmapx/hardlinks, and the other
#     workspace packages the data-manager imports)
#   - services/motis/tools/transitous/requirements.txt (pulled into the
#     runtime stage for the Transitous GTFS pipeline)
#
# Build command (from repo root):
#   docker build -t openmapx-data-manager -f services/data-manager/Dockerfile .
#
# The GitHub Actions workflow at .github/workflows/docker.yml builds this
# image with `context: .` for the same reason.

FROM docker.io/golang:1.27.2@sha256:5bc7f572bbaa98885a3a1fd9c0aa76b59e3e14e8628bfc316bbfd0c701e4818c AS build-gtfsclean
# Pin gtfsclean to a commit (the project only publishes rolling snapshot-N tags)
# instead of @latest so the build is reproducible and can't silently pull new code.
WORKDIR /tmp/gtfsclean-build
RUN GOPROXY=direct go mod init openmapx.local/gtfsclean-build && \
    GOPROXY=direct go get github.com/public-transport/gtfsclean@013af793337b759e782c3f8919e0b535cb702944 && \
    GOPROXY=direct go get golang.org/x/text@v0.39.0 && \
    GOPROXY=direct go build -trimpath -o /usr/local/bin/gtfsclean github.com/public-transport/gtfsclean

FROM node:24-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS base

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
COPY packages/transitous-core/package.json packages/transitous-core/
COPY packages/core/package.json packages/core/
COPY packages/hey-api-client-fetch/package.json packages/hey-api-client-fetch/
COPY packages/i18n/package.json packages/i18n/
COPY packages/cli/package.json packages/cli/
COPY packages/air-quality/package.json packages/air-quality/
COPY packages/integration-framework/package.json packages/integration-framework/
COPY packages/mobility-core/package.json packages/mobility-core/
COPY packages/place-ids/package.json packages/place-ids/

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
COPY packages/transitous-core/package.json packages/transitous-core/
COPY packages/core/package.json packages/core/
COPY packages/hey-api-client-fetch/package.json packages/hey-api-client-fetch/
COPY packages/i18n/package.json packages/i18n/
COPY packages/cli/package.json packages/cli/
COPY packages/air-quality/package.json packages/air-quality/
COPY packages/integration-framework/package.json packages/integration-framework/
COPY packages/mobility-core/package.json packages/mobility-core/
COPY packages/place-ids/package.json packages/place-ids/

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

FROM node:24-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS runner
WORKDIR /app
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Explicitly upgrade libraries already satisfied by the pinned base image:
# Require Expat's 2.5.0-1+deb12u4 security update rather than reusing an older
# cached package-install layer. libpcre2-8-0 fixes CVE-2026-86145,
# CVE-2026-89157 and CVE-2026-89161.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      osmium-tool curl unzip bzip2 lbzip2 ca-certificates age \
      git python3 python3-pip python3-venv wget rsync openssh-client \
      libexpat1=2.5.0-1+deb12u4 libpcre2-8-0 \
    && rm -rf /var/lib/apt/lists/*

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
# import.
# db-schema needs its own node_modules so the symlinked drizzle-orm resolves
# from its source files at runtime; the other two have no prod externals so
# only the source is needed.
COPY packages/db-schema/ ./packages/db-schema/
COPY --from=prod-deps /app/packages/db-schema/node_modules ./packages/db-schema/node_modules
COPY packages/hardlinks/ ./packages/hardlinks/
COPY packages/motis-feed-proxy-config/ ./packages/motis-feed-proxy-config/
COPY packages/mobility-formats/ ./packages/mobility-formats/
COPY --from=prod-deps /app/packages/mobility-formats/node_modules ./packages/mobility-formats/node_modules
COPY packages/transitous-core/ ./packages/transitous-core/
COPY --from=prod-deps /app/packages/transitous-core/node_modules ./packages/transitous-core/node_modules
COPY packages/core/ ./packages/core/
COPY --from=prod-deps /app/packages/core/node_modules ./packages/core/node_modules
COPY packages/hey-api-client-fetch/ ./packages/hey-api-client-fetch/

# Transitive runtime dependencies of @openmapx/core and @openmapx/cli, which
# data-manager imports.
COPY packages/place-ids/ ./packages/place-ids/
COPY packages/air-quality/ ./packages/air-quality/
COPY --from=prod-deps /app/packages/air-quality/node_modules ./packages/air-quality/node_modules
COPY packages/integration-framework/ ./packages/integration-framework/
COPY --from=prod-deps /app/packages/integration-framework/node_modules ./packages/integration-framework/node_modules
COPY packages/mobility-core/ ./packages/mobility-core/
COPY --from=prod-deps /app/packages/mobility-core/node_modules ./packages/mobility-core/node_modules

# packages/cli source + node_modules — bundled for parity with apps/api's
# runner (admin-cli.ts spawns the CLI for data jobs when no host bind-mount
# with the CLI is present); tiny, no native deps.
COPY packages/cli/ packages/cli/
COPY --from=prod-deps /app/packages/cli/node_modules ./packages/cli/node_modules

COPY --from=builder /app/services/data-manager/dist ./services/data-manager/dist
COPY services/data-manager/package.json ./services/data-manager/

# tsx resolves tsconfig paths + .js -> .ts at runtime for the workspace
# packages that ship TypeScript source.
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
CMD ["node", "--import", "tsx/esm", "dist/supervisor.js"]

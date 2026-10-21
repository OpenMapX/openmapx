# syntax=docker/dockerfile:1.19
#
# IMPORTANT: build context MUST be the repo root. This Dockerfile reaches
# outside its own directory to pick up:
#   - pnpm-workspace.yaml + workspace package.json files (for dependency
#     resolution of the workspace packages the data-manager bundles)
#   - the bundled workspace sources and scripts/build-runtime-bundles.mjs
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
COPY --chmod=0755 services/motis/tools/transitous/build-gtfsclean.sh /usr/local/bin/build-gtfsclean
RUN build-gtfsclean

FROM node:24.22.1-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS base

# Read the pnpm version directly from the repo root package.json to ensure
# lockfile resolution stays reproducible across local and CI Docker builds.
COPY package.json /tmp/package.json
RUN corepack enable && \
    corepack prepare "$(node -e "console.log(require('/tmp/package.json').packageManager)")" --activate && \
    pnpm --version

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
COPY packages/extension-contracts/package.json packages/extension-contracts/
COPY packages/hey-api-client-fetch/package.json packages/hey-api-client-fetch/
COPY packages/i18n/package.json packages/i18n/
COPY packages/cli/package.json packages/cli/
COPY packages/air-quality/package.json packages/air-quality/
COPY packages/integration-framework/package.json packages/integration-framework/
COPY packages/mobility-core/package.json packages/mobility-core/
COPY packages/place-ids/package.json packages/place-ids/

RUN pnpm install --frozen-lockfile

FROM deps AS bundle
WORKDIR /app

COPY tsconfig.base.json ./
# The workspace packages the bundles include, not every installed package.
COPY packages/air-quality/ packages/air-quality/
COPY packages/cli/ packages/cli/
COPY packages/core/ packages/core/
COPY packages/db-schema/ packages/db-schema/
COPY packages/extension-contracts/ packages/extension-contracts/
COPY packages/hardlinks/ packages/hardlinks/
COPY packages/mobility-core/ packages/mobility-core/
COPY packages/mobility-formats/ packages/mobility-formats/
COPY packages/motis-feed-proxy-config/ packages/motis-feed-proxy-config/
COPY packages/transitous-core/ packages/transitous-core/
COPY services/data-manager/ services/data-manager/
# Producer acquisition captures this trusted metadata in each release
# contract; the bundle carries it as an asset.
COPY integrations/poi-overture/manifest.json integrations/poi-overture/manifest.json
COPY scripts/build-runtime-bundles.mjs scripts/module-specifiers.mjs scripts/
ARG EXPECTED_BUNDLE_DIGEST=
RUN node scripts/build-runtime-bundles.mjs data-manager --expect "$EXPECTED_BUNDLE_DIGEST"

# Only the installed package directories the bundles load, with the
# node_modules links between them. The bundle build lists them from this same
# install, so a dependency's production or development classification does
# not matter here.
FROM deps AS runtime-packages
COPY scripts/copy-runtime-packages.mjs scripts/
COPY --from=bundle /app/services/data-manager/dist/runtime-packages.json /tmp/runtime-packages.json
RUN node scripts/copy-runtime-packages.mjs /tmp/runtime-packages.json /app /runtime

FROM node:24.22.1-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS runner
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

ARG DUCKDB_VERSION=1.5.6
ARG DUCKDB_SHA256_AMD64=6e89deac1ebbc36eed0291caf8b567b030c7b86ac35998f71854e22b3c5d5e2f
ARG DUCKDB_SHA256_ARM64=c544e92c9b7c31fc53c2139802cabd8e2d1b2b3e3f933117f31611239c1402db
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

# Run as a dedicated non-root user. The data-manager writes to /data which is
# bind-mounted from the host — the host-side permissions need to allow writes
# by UID/GID 1001, or operators can override via `docker run --user` /
# compose `user:`. The Node slim image ships a "node" user at UID 1000 we could reuse,
# but the 1001 UID aligns with conventions used by the rest of the project's
# service images and avoids colliding with host user IDs.
RUN groupadd --system --gid 1001 datamgr \
    && useradd --system --uid 1001 --gid datamgr --create-home --home-dir /home/datamgr datamgr \
    && rm -rf /usr/local/lib/node_modules/npm \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx \
    && chown datamgr:datamgr /app

# The bundles import their npm dependencies by path from the pnpm store, so the
# runner needs the bundles and the store packages they load, and no workspace
# source.
# Assign ownership while copying: a recursive chown afterwards would store a
# second copy of every file, including node_modules, in its own layer.
COPY --chown=datamgr:datamgr --from=runtime-packages /runtime/node_modules ./node_modules
COPY --chown=datamgr:datamgr --from=bundle /app/services/data-manager/dist ./services/data-manager/dist
# Every dependency file the bundles pin must exist among the copied packages.
RUN node -e 'const fs=require("node:fs"),p=require("node:path");const d="/app/services/data-manager/dist";const missing=JSON.parse(fs.readFileSync(p.join(d,"runtime-externals.json"),"utf8")).filter((f)=>!fs.existsSync(p.join(d,f)));if(missing.length){console.error("Missing bundle dependencies:",missing);process.exit(1)}'

USER datamgr:datamgr

WORKDIR /app/services/data-manager
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD ["curl", "-fs", "http://localhost:4000/status"]
CMD ["node", "dist/supervisor.mjs"]

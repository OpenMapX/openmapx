# syntax=docker/dockerfile:1.19
#
# IMPORTANT: build context MUST be the repo root. This Dockerfile reaches
# outside its own directory to pick up:
#   - pnpm-workspace.yaml + workspace package.json files (for dependency
#     resolution of the workspace packages the data-manager bundles)
#   - the bundled workspace sources and scripts/build-runtime-bundles.mjs
#
# Transitous's upstream Python and gtfsclean run in the transitous-runner
# image, never here.
#
# Build command (from repo root):
#   docker build -t openmapx-data-manager -f services/data-manager/Dockerfile .
#
# The GitHub Actions workflow at .github/workflows/docker.yml builds this
# image with `context: .` for the same reason.

FROM node:24.22.2-trixie-slim@sha256:0820eaa85e07d0490446dd01d14707e17e6108a36988cf374899cd057eb3812d AS base

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
# pnpm checks every patched dependency's file hash, installed here or not.
COPY patches/ patches/
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
# The bundle carries the API migration journal as an asset: at startup the
# service waits until the database holds the newest migration it names.
COPY apps/api/src/db/migrations/meta/_journal.json apps/api/src/db/migrations/meta/_journal.json
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

FROM node:24.22.2-trixie-slim@sha256:0820eaa85e07d0490446dd01d14707e17e6108a36988cf374899cd057eb3812d AS runner
WORKDIR /app
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Explicitly upgrade libraries already satisfied by the pinned base image:
# Expat 2.9.0-1~deb13u1 fixes CVE-2026-77214 (DSA-6566-1); Debian may replace
# older revisions in its repositories. Trixie's libpcre2-8-0 10.46-1~deb13u2
# point release already fixes CVE-2026-86145, CVE-2026-89157 and
# CVE-2026-89161, so it needs no floor. libbrotli1 1.1.0-2+deb13u1 fixes
# CVE-2026-111497 (DSA-6582-1). libssl3t64 and openssl 3.5.7-1~deb13u3 fix
# CVE-2026-84782 (DSA-6531-1); curl, git and ca-certificates pull them in, and
# a release build can restore this layer from the registry build cache
# with the versions it held then. Raising a version check here changes the
# instruction, so that layer is not reused.
# apt and libapt-pkg7.0 3.0.4 fix CVE-2026-109518 (Debian DSA-6607-1).
# zlib1g 1:1.3.dfsg+really1.3.1-1+deb13u1 fixes CVE-2026-76844 and CVE-2026-85091.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      osmium-tool curl unzip bzip2 lbzip2 ca-certificates git \
      apt libapt-pkg7.0 libexpat1 libpcre2-8-0 libbrotli1 libssl3t64 openssl zlib1g \
    && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' apt)" ge '3.0.4' \
    && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' libapt-pkg7.0)" ge '3.0.4' \
    && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' libexpat1)" ge '2.9.0-1~deb13u1' \
    && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' libbrotli1)" ge '1.1.0-2+deb13u1' \
    && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' libssl3t64)" ge '3.5.7-1~deb13u3' \
    && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' openssl)" ge '3.5.7-1~deb13u3' \
    && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' zlib1g)" ge '1:1.3.dfsg+really1.3.1-1+deb13u1' \
    && rm -rf /var/lib/apt/lists/*

ARG DUCKDB_VERSION=2.0.0
ARG DUCKDB_SHA256_AMD64=c6507206baf7793c6013dbd82368469a45f20dc0e17a6f92f204602f652ed2bc
ARG DUCKDB_SHA256_ARM64=859e1875d2a9515fbb4bf8871061437a14af82320da68c753f094c4b776348fe
ARG DUCKDB_EXT_HTTPFS_SHA256_AMD64=ee6c7d7e60a5da1b6f6bf6156b4298b55ddce0496a5bfe628bd6ab6d47eb8e3e
ARG DUCKDB_EXT_HTTPFS_SHA256_ARM64=f524888fc7d74cc0c6c4a8f7ed5beedac5b12e71cb426503f882c72ce6afbd43
ARG DUCKDB_EXT_SPATIAL_SHA256_AMD64=8d4bf1ab198806f123821d52ff5131745baaa19d5e91bd6b9772db922d31a228
ARG DUCKDB_EXT_SPATIAL_SHA256_ARM64=f0bf8e87876af932f529ce0c57015e3ee39954de9c9eb5bc05f5eb9c212f4744
ARG DUCKDB_EXT_POSTGRES_SCANNER_SHA256_AMD64=54b3d751cafc9ffa439886b1607d0ee758dab4dc070f0171e779b95f2f3e554f
ARG DUCKDB_EXT_POSTGRES_SCANNER_SHA256_ARM64=afe7f2bd798b61e4c2e1f96deedaa70a21d15eebc8cd9470beb923951d0ce58a
ARG DUCKDB_EXT_H3_SHA256_AMD64=7514dc2834ca9c0af0962b796470a54c706ec69c82df4fb3cde1666045f41c2b
ARG DUCKDB_EXT_H3_SHA256_ARM64=ec3e8124984b60c258131589ef22aaaa1877b2b2033a05a3a5901be32d01d7f4
RUN set -eux; \
    arch="$(uname -m)"; \
    case "$arch" in \
      x86_64) duckdb_arch=linux-amd64; expected_sha="$DUCKDB_SHA256_AMD64" ;; \
      aarch64|arm64) duckdb_arch=linux-arm64; expected_sha="$DUCKDB_SHA256_ARM64" ;; \
      *) echo "Unsupported arch $arch for DuckDB CLI install" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/duckdb/duckdb/releases/download/v${DUCKDB_VERSION}/duckdb-cli-${duckdb_arch}.tar.gz" -o /tmp/duckdb.tar.gz; \
    echo "${expected_sha}  /tmp/duckdb.tar.gz" | sha256sum -c -; \
    mkdir /tmp/duckdb-bin; \
    tar -xzf /tmp/duckdb.tar.gz -C /tmp/duckdb-bin duckdb; \
    mv /tmp/duckdb-bin/duckdb /usr/local/bin/duckdb; \
    chmod +x /usr/local/bin/duckdb; \
    rm -rf /tmp/duckdb.tar.gz /tmp/duckdb-bin; \
    duckdb --version
# Pre-install and checksum-pin every DuckDB extension so runtime pulls/ingests
# never download mutable extension binaries or depend on HOME=/tmp caches.
# DuckDB refuses local-file installs of community extensions (requiring .info
# community metadata), so `h3` is installed from `community` and then verified
# byte-for-byte against the SHA-256-checked copy via `cmp`.
RUN set -eux; \
    arch="$(uname -m)"; \
    case "$arch" in \
      x86_64) \
        ext_arch=linux_amd64; \
        sha_httpfs="$DUCKDB_EXT_HTTPFS_SHA256_AMD64"; \
        sha_spatial="$DUCKDB_EXT_SPATIAL_SHA256_AMD64"; \
        sha_postgres="$DUCKDB_EXT_POSTGRES_SCANNER_SHA256_AMD64"; \
        sha_h3="$DUCKDB_EXT_H3_SHA256_AMD64" ;; \
      aarch64|arm64) \
        ext_arch=linux_arm64; \
        sha_httpfs="$DUCKDB_EXT_HTTPFS_SHA256_ARM64"; \
        sha_spatial="$DUCKDB_EXT_SPATIAL_SHA256_ARM64"; \
        sha_postgres="$DUCKDB_EXT_POSTGRES_SCANNER_SHA256_ARM64"; \
        sha_h3="$DUCKDB_EXT_H3_SHA256_ARM64" ;; \
      *) echo "Unsupported arch $arch for DuckDB extensions" >&2; exit 1 ;; \
    esac; \
    tmp_dir=/tmp/duckdb-ext; \
    ext_dir=/opt/duckdb/extensions; \
    mkdir -p "$tmp_dir" "$ext_dir"; \
    for ext in httpfs spatial postgres_scanner; do \
      curl -fsSL "https://extensions.duckdb.org/v${DUCKDB_VERSION}/${ext_arch}/${ext}.duckdb_extension.gz" \
        -o "${tmp_dir}/${ext}.duckdb_extension.gz"; \
    done; \
    curl -fsSL "https://community-extensions.duckdb.org/v${DUCKDB_VERSION}/${ext_arch}/h3.duckdb_extension.gz" \
      -o "${tmp_dir}/h3.duckdb_extension.gz"; \
    printf '%s  %s\n' \
      "$sha_httpfs" "${tmp_dir}/httpfs.duckdb_extension.gz" \
      "$sha_spatial" "${tmp_dir}/spatial.duckdb_extension.gz" \
      "$sha_postgres" "${tmp_dir}/postgres_scanner.duckdb_extension.gz" \
      "$sha_h3" "${tmp_dir}/h3.duckdb_extension.gz" \
      | sha256sum -c -; \
    gunzip "${tmp_dir}"/*.gz; \
    duckdb -bail -c "SET extension_directories=['${ext_dir}']; INSTALL '${tmp_dir}/httpfs.duckdb_extension'; INSTALL '${tmp_dir}/spatial.duckdb_extension'; INSTALL '${tmp_dir}/postgres_scanner.duckdb_extension'; INSTALL h3 FROM community;"; \
    cmp "${tmp_dir}/h3.duckdb_extension" "${ext_dir}/v${DUCKDB_VERSION}/${ext_arch}/h3.duckdb_extension"; \
    rm -rf "$tmp_dir"; \
    chmod -R a+rX /opt/duckdb; \
    duckdb -bail -c "SET extension_directories=['${ext_dir}']; SET autoinstall_known_extensions=false; SET autoload_known_extensions=false; LOAD httpfs; LOAD spatial; LOAD postgres; LOAD h3; SELECT CASE WHEN CAST(h3_latlng_to_cell(52.52, 13.405, 8) AS BIGINT) = 613036919439228927 THEN 'ok' ELSE error('h3 mismatch') END;"
ENV OVERTURE_DUCKDB_EXTENSION_DIR=/opt/duckdb/extensions

ENV NODE_ENV=production

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

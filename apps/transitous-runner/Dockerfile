# syntax=docker/dockerfile:1.20
#
# The private Transitous runner.
#
# This image exists so third-party upstream Python never executes inside a
# service that holds platform authority. It therefore ships the *minimum* that
# the upstream catalog scripts need — python3 with the pinned Transitous
# requirements, gtfsclean, and `age` for encrypted feed credentials — and
# deliberately ships no Docker CLI, no Compose plugin, and no repository
# checkout.
#
# IMPORTANT: build context MUST be the repo root; the runtime stage picks up
# the pinned, hash-checked lock `services/motis/tools/transitous/requirements.txt`.
#
# Build command (from repo root):
#   docker build -t openmapx-transitous-runner -f apps/transitous-runner/Dockerfile .

FROM docker.io/golang:1.27.4@sha256:205c7636d74e0ffbe3d007162df7d74f859f5a8c8322dfb9f907977686c126cf AS build-gtfsclean
# Pin gtfsclean to a commit (the project only publishes rolling snapshot-N tags)
# instead of @latest so the build is reproducible and can't silently pull new code.
WORKDIR /tmp/gtfsclean-build
COPY --chmod=0755 services/motis/tools/transitous/build-gtfsclean.sh /usr/local/bin/build-gtfsclean
RUN build-gtfsclean

FROM node:24.22.2-trixie-slim@sha256:0820eaa85e07d0490446dd01d14707e17e6108a36988cf374899cd057eb3812d AS base
COPY package.json /tmp/package.json
RUN corepack enable && \
    corepack prepare "$(node -e "console.log(require('/tmp/package.json').packageManager)")" --activate && \
    pnpm --version

FROM base AS deps
WORKDIR /app
ENV HUSKY=0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
# pnpm checks every patched dependency's file hash, installed here or not.
COPY patches/ patches/
# Only the workspace packages the runner reaches. Manifests stay separate from
# source, so a source edit keeps the dependency install cached.
COPY --parents \
    packages/air-quality/package.json \
    packages/core/package.json \
    packages/extension-contracts/package.json \
    packages/hey-api-client-fetch/package.json \
    packages/mobility-core/package.json \
    packages/mobility-formats/package.json \
    packages/motis-feed-proxy-config/package.json \
    packages/transitous-core/package.json \
    ./
COPY apps/transitous-runner/package.json apps/transitous-runner/
RUN pnpm install --frozen-lockfile

# Bundles the runner and the workspace code it reaches into dist/. The release
# planner fingerprints this bundle; release builds pass its digest so a
# different bundle fails the build instead of shipping under the plan's name.
FROM deps AS bundle
WORKDIR /app
COPY --parents \
    packages/air-quality/ \
    packages/core/ \
    packages/extension-contracts/ \
    packages/hey-api-client-fetch/ \
    packages/mobility-core/ \
    packages/mobility-formats/ \
    packages/motis-feed-proxy-config/ \
    packages/transitous-core/ \
    ./
COPY apps/transitous-runner/ apps/transitous-runner/
COPY scripts/build-runtime-bundles.mjs scripts/module-specifiers.mjs scripts/
ARG EXPECTED_BUNDLE_DIGEST=
RUN node scripts/build-runtime-bundles.mjs transitous-runner --expect "$EXPECTED_BUNDLE_DIGEST"

# Only the installed package directories the bundles load, with the
# node_modules links between them. The bundle build lists them from this same
# install, so a dependency's production or development classification does
# not matter here.
FROM deps AS runtime-packages
COPY scripts/copy-runtime-packages.mjs scripts/
COPY --from=bundle /app/apps/transitous-runner/dist/runtime-packages.json /tmp/runtime-packages.json
RUN node scripts/copy-runtime-packages.mjs /tmp/runtime-packages.json /app /runtime

# The runner needs no package manager: starting from the plain Node image keeps
# the pnpm that corepack prepared for the build stages, and its bundled
# dependencies, out of the shipped image.
FROM node:24.22.2-trixie-slim@sha256:0820eaa85e07d0490446dd01d14707e17e6108a36988cf374899cd057eb3812d AS runner
WORKDIR /app
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# git is required because the upstream attribution script reads the catalog's
# submodule metadata; there is no credential helper and no remote configured.
# Explicitly upgrade PCRE2 and Expat inherited from the pinned base, and
# libssl3t64 and openssl (3.5.7-1~deb13u3 fixes CVE-2026-84782, DSA-6531-1)
# that curl, git, Python and ca-certificates pull in, to their security fixes.
# Expat 2.9.0-1~deb13u1 fixes CVE-2026-77214 (DSA-6566-1). Trixie's PCRE2
# 10.46-1~deb13u2 point release already fixes CVE-2026-86145, CVE-2026-89157
# and CVE-2026-89161, so it needs no floor. The version checks fail a stale
# mirror and, when raised, invalidate this layer in the registry build cache.
# apt and libapt-pkg7.0 3.0.4 fix CVE-2026-109518 (Debian DSA-6607-1).
# zlib1g 1:1.3.dfsg+really1.3.1-1+deb13u1 fixes CVE-2026-76844 and CVE-2026-85091.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates curl git python3 python3-pip python3-venv age tini apt libapt-pkg7.0 libpcre2-8-0 libexpat1 libssl3t64 openssl zlib1g \
    && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' apt)" ge 3.0.4 \
    && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' libapt-pkg7.0)" ge 3.0.4 \
    && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' libexpat1)" ge 2.9.0-1~deb13u1 \
    && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' libssl3t64)" ge 3.5.7-1~deb13u3 \
    && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' openssl)" ge 3.5.7-1~deb13u3 \
    && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' zlib1g)" ge 1:1.3.dfsg+really1.3.1-1+deb13u1 \
    && apt-get clean -y \
    && rm -rf /var/lib/apt/lists/* \
    && rm -f /usr/lib/python3.*/EXTERNALLY-MANAGED

COPY services/motis/tools/transitous/requirements.txt /tmp/transitous-requirements.txt
RUN pip3 install --no-cache-dir --require-hashes -r /tmp/transitous-requirements.txt \
    && rm -f /tmp/transitous-requirements.txt
COPY --from=build-gtfsclean /usr/local/bin/gtfsclean /usr/local/bin/gtfsclean

ENV NODE_ENV=production
ENV PYTHONDONTWRITEBYTECODE=1
ENV TRANSITOUS_RUNNER_PORT=4400

# Run as a dedicated non-root user. Upstream Python runs under this identity and
# has no route to escalate: the catalog is mounted read-only apart from its
# output directory, and nothing else in the image is writable.
RUN groupadd --system --gid 1001 transitous \
    && useradd --system --uid 1001 --gid transitous --create-home --home-dir /home/transitous transitous \
    && rm -rf /usr/local/lib/node_modules/npm \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx \
    && chown transitous:transitous /app

# The bundle imports its npm dependencies by path from the pnpm store, so the
# runner needs the bundle and the store packages it loads, and no workspace
# source.
# Assign ownership while copying: a recursive chown afterwards would store a
# second copy of every file in its own layer.
COPY --chown=transitous:transitous --from=runtime-packages /runtime/node_modules ./node_modules
COPY --chown=transitous:transitous --from=bundle /app/apps/transitous-runner/dist ./apps/transitous-runner/dist
# Every dependency file the bundle pins must exist among the copied packages.
RUN node -e 'const fs=require("node:fs"),p=require("node:path");const d="/app/apps/transitous-runner/dist";const missing=JSON.parse(fs.readFileSync(p.join(d,"runtime-externals.json"),"utf8")).filter((f)=>!fs.existsSync(p.join(d,f)));if(missing.length){console.error("Missing bundle dependencies:",missing);process.exit(1)}'

USER transitous:transitous

WORKDIR /app/apps/transitous-runner
EXPOSE 4400
HEALTHCHECK --interval=15s --timeout=3s --retries=5 CMD ["curl", "-fsS", "http://127.0.0.1:4400/health"]
# Forward signals to Node and reap detached descendants adopted during shutdown.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.mjs"]

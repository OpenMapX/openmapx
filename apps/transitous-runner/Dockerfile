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
# `services/motis/tools/transitous/requirements.txt`, which is the same pinned,
# hash-checked lock the transitous-tools image uses.
#
# Build command (from repo root):
#   docker build -t openmapx-transitous-runner -f apps/transitous-runner/Dockerfile .

FROM docker.io/golang:1.27.2@sha256:5bc7f572bbaa98885a3a1fd9c0aa76b59e3e14e8628bfc316bbfd0c701e4818c AS build-gtfsclean
# Pin gtfsclean to a commit (the project only publishes rolling snapshot-N tags)
# instead of @latest so the build is reproducible and can't silently pull new code.
WORKDIR /tmp/gtfsclean-build
COPY --chmod=0755 services/motis/tools/transitous/build-gtfsclean.sh /usr/local/bin/build-gtfsclean
RUN build-gtfsclean

FROM node:24.21.0-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS base
COPY package.json /tmp/package.json
RUN corepack enable && \
    corepack prepare "$(node -e "console.log(require('/tmp/package.json').packageManager)")" --activate && \
    pnpm --version

FROM base AS deps
WORKDIR /app
ENV HUSKY=0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
# Only the workspace packages the runner reaches. Manifests stay separate from
# source, so a source edit keeps the dependency install cached.
COPY --parents \
    packages/air-quality/package.json \
    packages/core/package.json \
    packages/extension-contracts/package.json \
    packages/hey-api-client-fetch/package.json \
    packages/mobility-core/package.json \
    packages/mobility-formats/package.json \
    packages/transitous-core/package.json \
    ./
COPY apps/transitous-runner/package.json apps/transitous-runner/
RUN pnpm install --frozen-lockfile

FROM base AS prod-deps
WORKDIR /app
ENV HUSKY=0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY --parents \
    packages/air-quality/package.json \
    packages/core/package.json \
    packages/extension-contracts/package.json \
    packages/hey-api-client-fetch/package.json \
    packages/mobility-core/package.json \
    packages/mobility-formats/package.json \
    packages/transitous-core/package.json \
    ./
COPY apps/transitous-runner/package.json apps/transitous-runner/
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

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
    packages/transitous-core/ \
    ./
COPY apps/transitous-runner/ apps/transitous-runner/
COPY scripts/build-runtime-bundles.mjs scripts/module-specifiers.mjs scripts/
ARG EXPECTED_BUNDLE_DIGEST=
RUN node scripts/build-runtime-bundles.mjs transitous-runner --expect "$EXPECTED_BUNDLE_DIGEST"

# Only the installed package directories the bundles load, listed by the bundle
# build, with the node_modules links between them.
FROM prod-deps AS runtime-packages
COPY scripts/copy-runtime-packages.mjs scripts/
COPY --from=bundle /app/apps/transitous-runner/dist/runtime-packages.json /tmp/runtime-packages.json
RUN node scripts/copy-runtime-packages.mjs /tmp/runtime-packages.json /app /runtime

FROM base AS runner
WORKDIR /app
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# git is required because the upstream attribution script reads the catalog's
# submodule metadata; there is no credential helper and no remote configured.
# Explicitly upgrade PCRE2 inherited from the pinned base to its security fix.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates curl git python3 python3-pip python3-venv age libpcre2-8-0 \
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
CMD ["node", "dist/index.mjs"]

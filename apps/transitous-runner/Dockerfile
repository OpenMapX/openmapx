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
# Preserve workspace paths without including source in the install cache key.
COPY --parents packages/*/package.json ./
COPY apps/transitous-runner/package.json apps/transitous-runner/
RUN pnpm install --frozen-lockfile

FROM base AS prod-deps
WORKDIR /app
ENV HUSKY=0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
# Preserve workspace paths without including source in the install cache key.
COPY --parents packages/*/package.json ./
COPY apps/transitous-runner/package.json apps/transitous-runner/
RUN pnpm install --frozen-lockfile --prod --ignore-scripts && \
    rm -rf node_modules/.pnpm/image-size@*
# image-size belongs to Metro's mobile build toolchain, not this runtime. Do not
# copy that unused, currently vulnerable package into the production image
# merely because pnpm uses a shared workspace virtual store.

FROM deps AS builder
WORKDIR /app
COPY packages/ packages/
COPY apps/transitous-runner/ apps/transitous-runner/
COPY tsconfig.base.json ./
WORKDIR /app/apps/transitous-runner
RUN pnpm build

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

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/apps/transitous-runner/node_modules ./apps/transitous-runner/node_modules
COPY --from=prod-deps /app/packages/core/node_modules ./packages/core/node_modules
COPY packages/core/ ./packages/core/
COPY packages/extension-contracts/ ./packages/extension-contracts/
COPY --from=prod-deps /app/packages/extension-contracts/node_modules ./packages/extension-contracts/node_modules
COPY --from=builder /app/apps/transitous-runner/dist ./apps/transitous-runner/dist
COPY apps/transitous-runner/package.json ./apps/transitous-runner/
COPY pnpm-workspace.yaml tsconfig.base.json ./

# Run as a dedicated non-root user. Upstream Python runs under this identity and
# has no route to escalate: the catalog is mounted read-only apart from its
# output directory, and nothing else in the image is writable.
RUN groupadd --system --gid 1001 transitous \
    && useradd --system --uid 1001 --gid transitous --create-home --home-dir /home/transitous transitous \
    && rm -rf /usr/local/lib/node_modules/npm \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx \
    && chown -R transitous:transitous /app /home/transitous

USER transitous:transitous

WORKDIR /app/apps/transitous-runner
EXPOSE 4400
HEALTHCHECK --interval=15s --timeout=3s --retries=5 CMD ["curl", "-fsS", "http://127.0.0.1:4400/health"]
CMD ["node", "--import", "tsx/esm", "dist/index.js"]

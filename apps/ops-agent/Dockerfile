# syntax=docker/dockerfile:1.20

FROM node:24.22.1-alpine@sha256:6a1c190e17215d844926b0677f4bf87273ff7d5e54db06d3b5b5863ab0b09a3d AS base
COPY package.json /tmp/package.json
RUN corepack enable && \
    corepack prepare "$(node -e "console.log(require('/tmp/package.json').packageManager)")" --activate && \
    pnpm --version

FROM base AS deps
WORKDIR /app
ENV HUSKY=0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
# Only the workspace packages the agent and its fixed CLI reach. Manifests stay
# separate from source, so a source edit keeps the dependency install cached.
COPY --parents \
    packages/air-quality/package.json \
    packages/cli/package.json \
    packages/core/package.json \
    packages/extension-contracts/package.json \
    packages/hardlinks/package.json \
    packages/hey-api-client-fetch/package.json \
    packages/integration-framework/package.json \
    packages/mobility-core/package.json \
    packages/mobility-formats/package.json \
    packages/motis-feed-proxy-config/package.json \
    packages/place-ids/package.json \
    packages/transitous-core/package.json \
    ./
COPY apps/ops-agent/package.json apps/ops-agent/
RUN pnpm install --frozen-lockfile

# Bundles the agent, its update helper and its fixed CLI, with the workspace
# code they reach, into dist/. The release planner fingerprints this bundle;
# release builds pass its digest so a different bundle fails the build.
FROM deps AS bundle
WORKDIR /app
COPY --parents \
    packages/air-quality/ \
    packages/cli/ \
    packages/core/ \
    packages/extension-contracts/ \
    packages/hardlinks/ \
    packages/hey-api-client-fetch/ \
    packages/integration-framework/ \
    packages/mobility-core/ \
    packages/mobility-formats/ \
    packages/motis-feed-proxy-config/ \
    packages/place-ids/ \
    packages/transitous-core/ \
    ./
COPY apps/ops-agent/ apps/ops-agent/
# The CLI imports these data-manager modules and, for `transit-registry bump`,
# this integration. The bundle embeds every built-in service manifest: the
# agent and its CLI run the release's manifests, not the host checkout's.
COPY --parents \
    services/*/service.json \
    services/data-manager/src/transitous-lock.ts \
    services/data-manager/src/gbfs-catalog-lock.ts \
    services/data-manager/src/utils/atomic-write.ts \
    integrations/transit-dynamic-registry/ \
    ./
COPY scripts/build-runtime-bundles.mjs scripts/module-specifiers.mjs scripts/
ARG EXPECTED_BUNDLE_DIGEST=
RUN node scripts/build-runtime-bundles.mjs ops-agent --expect "$EXPECTED_BUNDLE_DIGEST"

# Only the installed package directories the bundles load, with the
# node_modules links between them. The bundle build lists them from this same
# install, so a dependency's production or development classification does
# not matter here.
FROM deps AS runtime-packages
COPY scripts/copy-runtime-packages.mjs scripts/
COPY --from=bundle /app/apps/ops-agent/dist/runtime-packages.json /tmp/runtime-packages.json
RUN node scripts/copy-runtime-packages.mjs /tmp/runtime-packages.json /app /runtime

# The runner needs no package manager: starting from the plain Node image keeps
# the pnpm that corepack prepared for the build stages, and its bundled
# dependencies, out of the shipped image.
FROM node:24.22.1-alpine@sha256:6a1c190e17215d844926b0677f4bf87273ff7d5e54db06d3b5b5863ab0b09a3d AS runner
WORKDIR /app
# The pinned base predates Alpine's OpenSSL fix for CVE-2026-14456.
# git fetches community service repositories into services/.community.
RUN apk upgrade --no-cache libcrypto3 libssl3 && \
    apk add --no-cache ca-certificates curl docker-cli docker-cli-compose git tini && \
    rm -rf /usr/local/lib/node_modules/npm && \
    rm -f /usr/local/bin/npm /usr/local/bin/npx

ENV NODE_ENV=production
ENV HOME=/home/node
ENV PORT=4300

# The bundles import their npm dependencies by path from the pnpm store, so the
# runner needs the bundles and the store packages they load, and no workspace
# source.
# Assign ownership while copying: a recursive chown afterwards would store a
# second copy of every file in its own layer.
COPY --chown=node:node --from=runtime-packages /runtime/node_modules ./node_modules
COPY --chown=node:node --from=bundle /app/apps/ops-agent/dist ./apps/ops-agent/dist
# Every dependency file the bundles pin must exist among the copied packages.
RUN node -e 'const fs=require("node:fs"),p=require("node:path");const d="/app/apps/ops-agent/dist";const missing=JSON.parse(fs.readFileSync(p.join(d,"runtime-externals.json"),"utf8")).filter((f)=>!fs.existsSync(p.join(d,f)));if(missing.length){console.error("Missing bundle dependencies:",missing);process.exit(1)}'

RUN chown node:node /app && chown -R node:node /home/node
USER node:node

WORKDIR /app/apps/ops-agent
# The fixed CLI must boot without the host's integration source tree. Catch
# eager imports of optional command implementations in the actual runtime image.
RUN node dist/cli.mjs --help > /dev/null
EXPOSE 4300
HEALTHCHECK --interval=15s --timeout=3s --retries=5 CMD ["curl", "-fsS", "http://127.0.0.1:4300/health"]
# A command's helper that outlives it is reparented to PID 1. tini reaps it:
# Node would leave it a zombie in the command's process group, and the
# contained-process runner waits for that group to empty.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/agent.mjs"]

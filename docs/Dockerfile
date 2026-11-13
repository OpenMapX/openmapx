# Build the OpenMapX documentation (Docusaurus) and serve it from nginx.
#
# The build context is `docs/` only — this package is a self-contained pnpm
# workspace (its own pnpm-workspace.yaml + pnpm-lock.yaml), fully decoupled from
# the monorepo workspace and the app build.
FROM node:24.22.2-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8 AS build
WORKDIR /app
COPY package.json /tmp/package.json
RUN corepack enable && \
    corepack prepare "$(node -e "console.log(require('/tmp/package.json').packageManager)")" --activate && \
    pnpm --version
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# The lockfile references patched dependencies by file hash, so `pnpm install`
# cannot resolve without the patch itself.
COPY patches/ patches/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm typecheck && pnpm build

FROM nginx:1.31.8-alpine@sha256:785835ea65db4bba6f021acc0f3be91b0fef76a53fe41f8588c6698d2aed0606
# The current official image predates Alpine's OpenSSL fix for CVE-2026-14456
# and later libexpat, util-linux, PCRE2, TIFF (CVE-2026-4775), libX11
# (CVE-2026-88806), Brotli (CVE-2026-111497), curl (CVE-2026-92392,
# 8.23.0-r0) and libxslt (CVE-2026-87636, CVE-2026-9947, 1.1.43-r4) fixes.
# Upgrade only the affected runtime libraries.
RUN apk upgrade --no-cache libcrypto3 libssl3 libexpat libuuid pcre2 tiff libx11 brotli-libs \
    curl libcurl libxslt
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/build /usr/share/nginx/html
EXPOSE 80

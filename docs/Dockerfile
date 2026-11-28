# Build the OpenMapX documentation (Docusaurus) and serve it from nginx.
#
# The build context is `docs/` only — this package is a self-contained pnpm
# workspace (its own pnpm-workspace.yaml + pnpm-lock.yaml), fully decoupled from
# the monorepo workspace and the app build.
FROM node:24.22.3-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS build
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

FROM nginx:1.31.8-alpine@sha256:fed7e14be83cbd2661a75cdc5b872d936cf155d46c327084d30b8df19ae88d72
# The current official image predates Alpine's OpenSSL fix for CVE-2026-14456
# and later libexpat, util-linux, PCRE2, TIFF (CVE-2026-4775), libX11
# (CVE-2026-88806), Brotli (CVE-2026-111497), curl (CVE-2026-92392,
# 8.23.0-r0), libxslt (CVE-2026-87636, CVE-2026-9947, 1.1.43-r4) and libxml2
# (CVE-2026-86144, 2.13.9-r3) fixes. Upgrade only the affected runtime libraries.
# libxml2 2.13.9-r4 fixes CVE-2026-86138, CVE-2026-86139, CVE-2026-86140,
# CVE-2026-86142 and CVE-2026-86143; 2.13.9-r5 fixes CVE-2026-11979. A build can
# restore this layer from the build cache with the packages it held then. The
# version floor checked after the upgrade changes this instruction, which keeps
# such a layer from being reused; it also fails the build on a mirror that
# doesn't have the fix yet.
RUN apk upgrade --no-cache libcrypto3 libssl3 libexpat libuuid pcre2 tiff libx11 brotli-libs \
    curl libcurl libxslt libxml2 && \
    libxml2="$(apk query --fields version libxml2)" && libxml2="${libxml2#Version: }" && \
    test -n "$libxml2" && test "$(apk version -t "$libxml2" 2.13.9-r5)" != "<"
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/build /usr/share/nginx/html
EXPOSE 80

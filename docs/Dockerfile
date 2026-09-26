# Build the OpenMapX documentation (Docusaurus) and serve it from nginx.
#
# The build context is `docs/` only — this package is a self-contained pnpm
# workspace (its own pnpm-workspace.yaml + pnpm-lock.yaml), fully decoupled from
# the monorepo workspace and the app build.
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS build
WORKDIR /app
COPY package.json /tmp/package.json
RUN corepack enable && corepack prepare "$(node -e "console.log(require('/tmp/package.json').packageManager)")" --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# The lockfile references patched dependencies by file hash, so `pnpm install`
# cannot resolve without the patch itself.
COPY patches/ patches/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM nginx:alpine@sha256:62ff2089abf5a9ed33bd232895bef5e22f7bb4b200675cec49a5ebc48e3d4ac8
# The current official image predates Alpine's OpenSSL fix for CVE-2026-14456
# and later libexpat and util-linux fixes. Upgrade only the affected runtime
# libraries.
RUN apk upgrade --no-cache libcrypto3 libssl3 libexpat libuuid
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/build /usr/share/nginx/html
EXPOSE 80

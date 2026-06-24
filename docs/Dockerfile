# Build the OpenMapX documentation (Docusaurus) and serve it from nginx.
#
# The build context is `docs/` only — this package is a self-contained pnpm
# workspace (its own pnpm-workspace.yaml + pnpm-lock.yaml), fully decoupled from
# the monorepo workspace and the app build.
FROM node:24-alpine@sha256:fb71d01345f11b708a3553c66e7c74074f2d506400ea81973343d915cb64eef0 AS build
WORKDIR /app
RUN npm install -g pnpm@11.1.2
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM nginx:alpine@sha256:20316569d8f81a160065d7d2a5eeffc7ca97d79022462ee255fd23fa103a6b5c
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/build /usr/share/nginx/html
EXPOSE 80

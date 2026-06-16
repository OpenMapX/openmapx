# Build the OpenMapX documentation (Docusaurus) and serve it from nginx.
#
# The build context is `docs/` only — this package is a self-contained pnpm
# workspace (its own pnpm-workspace.yaml + pnpm-lock.yaml), fully decoupled from
# the monorepo workspace and the app build.
FROM node:22-alpine@sha256:9385cd9f3001dfc3431e8ead12c43e9e1f87cc1b9b5c6cfd0f73865d405b27c4 AS build
WORKDIR /app
RUN npm install -g pnpm@11.1.2
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM nginx:alpine@sha256:8b1e78743a03dbb2c95171cc58639fef29abc8816598e27fb910ed2e621e589a
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/build /usr/share/nginx/html
EXPOSE 80

# Build the OpenMapX documentation (Docusaurus) and serve it from nginx.
#
# The build context is `docs/` only — this package is a self-contained pnpm
# workspace (its own pnpm-workspace.yaml + pnpm-lock.yaml), fully decoupled from
# the monorepo workspace and the app build.
FROM node:24-alpine@sha256:156b55f92e98ccd5ef49578a8cea0df4679826564bad1c9d4ef04462b9f0ded6 AS build
WORKDIR /app
RUN npm install -g pnpm@11.1.2
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM nginx:alpine@sha256:54f2a904c251d5a34adf545a72d32515a15e08418dae0266e23be2e18c66fefa
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/build /usr/share/nginx/html
EXPOSE 80

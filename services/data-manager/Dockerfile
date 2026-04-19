FROM node:24-slim AS builder
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends osmium-tool curl unzip bzip2 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json tsconfig.json ./
COPY src ./src
RUN npm install --silent && npx tsc

FROM node:24-slim
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends osmium-tool curl unzip bzip2 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
EXPOSE 4000
CMD ["node", "dist/index.js"]

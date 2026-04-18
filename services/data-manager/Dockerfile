FROM node:24-alpine AS builder
WORKDIR /app
RUN apk add --no-cache osmium-tool curl unzip bash bzip2
COPY package.json tsconfig.json ./
COPY src ./src
RUN npm install --silent && npx tsc

FROM node:24-alpine
WORKDIR /app
RUN apk add --no-cache osmium-tool curl unzip bash bzip2
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
EXPOSE 4000
CMD ["node", "dist/index.js"]

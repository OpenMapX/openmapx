import { existsSync } from "node:fs";
import { join } from "node:path";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import { registry } from "@integrations/transit-dynamic-registry/registry";
import { bielefeldClient } from "@openmapx/integration-shared-mobility/bielefeld-client";
import { cambioClient } from "@openmapx/integration-shared-mobility/cambio-client";
import { registerCarSharingClient } from "@openmapx/integration-shared-mobility/car-sharing-registry";
import { stadtteilAutoClient } from "@openmapx/integration-shared-mobility/stadtteilauto-client";
import { wuppertalClient } from "@openmapx/integration-shared-mobility/wuppertal-client";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import Fastify from "fastify";
import { auth } from "./auth";
import { db, sql } from "./db/index";
import { getAllIntegrations, initIntegrations, shutdownIntegrations } from "./integration-host";
import { redis } from "./redis";
import { autocompleteRoute } from "./routes/autocomplete";
import { capabilitiesRoute } from "./routes/capabilities";
import { categorySearchRoute } from "./routes/category-search";
import { dataSourcesRoute } from "./routes/data-sources";
import { directionsRoute } from "./routes/directions";
import { elevationRoute } from "./routes/elevation";
import { geocodeRoute } from "./routes/geocode";
import { gtfsRoute } from "./routes/gtfs";
import { isochroneRoute } from "./routes/isochrone";
import { mapillaryRoute } from "./routes/mapillary";
import { motisRoute } from "./routes/motis";
import { photosRoute } from "./routes/photos";
import { placesRoute } from "./routes/places";
import { risMapsRoute } from "./routes/ris-maps";
import { savedRoute } from "./routes/saved";
import { statusRoute } from "./routes/status";
import { tilesRoute } from "./routes/tiles";
import { trafficRoute } from "./routes/traffic";
import { transitRoute } from "./routes/transit";
import { winterSportsRoute } from "./routes/winter-sports";
import { gtfsManager } from "./services/gtfs/index";
import { motisManager } from "./services/motis/manager";

const server = Fastify({
  logger: true,
  routerOptions: {
    // DB HAFAS trip IDs can be ~300 chars when URL-encoded (default is 100)
    maxParamLength: 500,
  },
});

// Run database migrations on startup (idempotent — skips already-applied migrations)
const migrationsDir = join(import.meta.dirname ?? ".", "db", "migrations");
if (existsSync(migrationsDir)) {
  try {
    await migrate(db, { migrationsFolder: migrationsDir });
    server.log.info("Database migrations applied");
  } catch (err) {
    server.log.error(err, "Database migration failed");
  }
}

await server.register(helmet);
await server.register(cors, {
  origin: (process.env.CORS_ORIGIN ?? "http://localhost:3000").split(",").map((o) => o.trim()),
  credentials: true,
  exposedHeaders: ["X-Tile-Source"],
});

// Better Auth handler
server.route({
  method: ["GET", "POST"],
  url: "/api/auth/*",
  async handler(request, reply) {
    try {
      const url = new URL(request.url, `http://${request.headers.host}`);
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) {
        if (value) headers.append(key, Array.isArray(value) ? value.join(", ") : value);
      }
      const req = new Request(url.toString(), {
        method: request.method,
        headers,
        ...(request.body ? { body: JSON.stringify(request.body) } : {}),
      });
      const response = await auth.handler(req);
      reply.status(response.status);
      response.headers.forEach((value, key) => {
        reply.header(key, value);
      });
      reply.send(response.status === 204 ? null : await response.text());
    } catch (error) {
      server.log.error(error, "Auth error");
      reply.status(500).send({ error: "Internal authentication error" });
    }
  },
});

// Health check
server.get("/health", async () => ({ status: "ok" }));

// Capabilities (service availability)
await server.register(capabilitiesRoute, { prefix: "/api" });

// Routes
await server.register(geocodeRoute, { prefix: "/api" });
await server.register(autocompleteRoute, { prefix: "/api" });
await server.register(placesRoute, { prefix: "/api" });
await server.register(categorySearchRoute, { prefix: "/api" });
await server.register(directionsRoute, { prefix: "/api" });
await server.register(elevationRoute, { prefix: "/api" });
await server.register(trafficRoute, { prefix: "/api" });
await server.register(tilesRoute, { prefix: "/api" });
await server.register(mapillaryRoute, { prefix: "/api" });
await server.register(transitRoute, { prefix: "/api" });
await server.register(gtfsRoute, { prefix: "/api" });
await server.register(isochroneRoute, { prefix: "/api" });
await server.register(motisRoute, { prefix: "/api" });
await server.register(dataSourcesRoute, { prefix: "/api" });
await server.register(photosRoute, { prefix: "/api" });
await server.register(winterSportsRoute, { prefix: "/api" });
await server.register(risMapsRoute, { prefix: "/api" });
await server.register(savedRoute, { prefix: "/api" });
await server.register(statusRoute, { prefix: "/api" });

// Regional car-sharing clients (order = priority for enrichment merge:
// Cambio first = live data wins, open data sources enrich with extra fields)
registerCarSharingClient(cambioClient);
registerCarSharingClient(stadtteilAutoClient);
registerCarSharingClient(wuppertalClient);
registerCarSharingClient(bielefeldClient);

// Data source providers now registered by integration framework

// Session endpoint
server.get("/api/me", async (request, reply) => {
  const { fromNodeHeaders } = await import("better-auth/node");
  const session = await auth.api.getSession({
    headers: fromNodeHeaders(request.headers),
  });
  if (!session) {
    return reply.status(401).send({ error: "Unauthorized" });
  }
  return reply.send(session);
});

// GTFS manager
// Initialize local GTFS feed manager (non-blocking — server starts
// even if database is unavailable)
gtfsManager.initialize().catch((err) => {
  server.log.warn(err, "GTFS manager initialization failed");
});

// Self-hosted MOTIS
// Initialize MOTIS feed manager (synchronous — reads state from disk)
try {
  motisManager.initialize();
} catch (err) {
  server.log.warn(err, "MOTIS manager initialization failed");
}

// Integration framework
// Discover and load integrations from integrations/ directory
const integrationsDir = join(import.meta.dirname ?? ".", "..", "..", "..", "integrations");
const customIntegrationsDir = join(
  import.meta.dirname ?? ".",
  "..",
  "..",
  "..",
  "custom_integrations",
);
await initIntegrations(server, [integrationsDir, customIntegrationsDir]);

// Sanity check: ensure integrations were discovered
const loadedCount = getAllIntegrations().length;
if (loadedCount === 0) {
  server.log.error(
    `No integrations loaded! Expected integrations at ${integrationsDir}. ` +
      "Check that the integrations/ directory exists and contains valid manifests.",
  );
  if (process.env.NODE_ENV === "production") {
    process.exit(1);
  }
}
server.log.info(`Loaded ${loadedCount} integrations`);

// Debug endpoint: list loaded dynamic transit providers (auth required)
server.get("/api/transit/registry", async (req, reply) => {
  const { requireAuth } = await import("./utils/require-auth.js");
  if (!(await requireAuth(req, reply))) return;
  return { entries: registry.listEntries(), count: registry.entryCount };
});

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";

try {
  await server.listen({ port, host });
} catch (err) {
  server.log.error(err);
  process.exit(1);
}

// Graceful shutdown
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await shutdownIntegrations();
    await server.close();
    await redis?.disconnect();
    await sql.end();
    process.exit(0);
  });
}

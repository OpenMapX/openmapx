import { existsSync } from "node:fs";
import { join } from "node:path";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
// Data source providers moved to integrations (ev-charging, fuel, parking, bike-sharing, car-sharing, scooter-sharing)
import { bielefeldClient } from "@integrations/bike-sharing/shared-providers/bielefeld-client";
import { cambioClient } from "@integrations/bike-sharing/shared-providers/cambio-client";
import { registerCarSharingClient } from "@integrations/bike-sharing/shared-providers/car-sharing-registry";
import { stadtteilAutoClient } from "@integrations/bike-sharing/shared-providers/stadtteilauto-client";
import { wuppertalClient } from "@integrations/bike-sharing/shared-providers/wuppertal-client";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import Fastify from "fastify";
import { auth } from "./auth";
import { db, sql } from "./db/index";
import { initIntegrations, shutdownIntegrations } from "./integration-host";
import { redis } from "./redis";
// airQualityRoute moved to integrations/overlay-air-quality
import { autocompleteRoute } from "./routes/autocomplete";
import { capabilitiesRoute } from "./routes/capabilities";
import { categorySearchRoute } from "./routes/category-search";
import { dataSourcesRoute } from "./routes/data-sources";
import { directionsRoute } from "./routes/directions";
// earthquakeRoute moved to integrations/overlay-earthquakes
import { elevationRoute } from "./routes/elevation";
import { geocodeRoute } from "./routes/geocode";
import { gtfsRoute } from "./routes/gtfs";
import { hikingRoute } from "./routes/hiking";
import { isochroneRoute } from "./routes/isochrone";
import { mapillaryRoute } from "./routes/mapillary";
import { motisRoute } from "./routes/motis";
import { photosRoute } from "./routes/photos";
import { placesRoute } from "./routes/places";
import { risMapsRoute } from "./routes/ris-maps";
import { savedRoute } from "./routes/saved";
import { statusRoute } from "./routes/status";
import { streetviewRoute } from "./routes/streetview";
import { tilesRoute } from "./routes/tiles";
import { trafficRoute } from "./routes/traffic";
import { transitRoute } from "./routes/transit";
import { transitAttributionRoute } from "./routes/transit-attribution";
// wildfireRoute moved to integrations/overlay-wildfires
import { winterSportsRoute } from "./routes/winter-sports";
import { gtfsManager } from "./services/gtfs/index";
import { motisManager } from "./services/motis/manager";
import { registry } from "./services/transit/registry/index";

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
await server.register(streetviewRoute, { prefix: "/api" });
// airQualityRoute now handled by integration framework
await server.register(mapillaryRoute, { prefix: "/api" });
await server.register(transitRoute, { prefix: "/api" });
await server.register(transitAttributionRoute, { prefix: "/api" });
await server.register(gtfsRoute, { prefix: "/api" });
await server.register(hikingRoute, { prefix: "/api" });
await server.register(isochroneRoute, { prefix: "/api" });
await server.register(motisRoute, { prefix: "/api" });
await server.register(dataSourcesRoute, { prefix: "/api" });
await server.register(photosRoute, { prefix: "/api" });
// earthquakeRoute now handled by integration framework
// wildfireRoute now handled by integration framework
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

// Transit registry
// Initialize dynamic transit provider registry (non-blocking — server
// starts even if GitHub is unreachable)
registry
  .initialize()
  .then(() => registry.startRefresh())
  .catch((err) => {
    server.log.warn(err, "Transit registry initialization failed");
    // Start refresh anyway so it retries later
    registry.startRefresh();
  });

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
    registry.stopRefresh();
    await shutdownIntegrations();
    await server.close();
    await redis?.disconnect();
    await sql.end();
    process.exit(0);
  });
}

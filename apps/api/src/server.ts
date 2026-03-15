import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import Fastify from "fastify";
import { auth } from "./auth";
import { sql } from "./db/index";
import { redis } from "./redis";
import { airQualityRoute } from "./routes/air-quality";
import { autocompleteRoute } from "./routes/autocomplete";
import { categorySearchRoute } from "./routes/category-search";
import { dataSourcesRoute } from "./routes/data-sources";
import { directionsRoute } from "./routes/directions";
import { geocodeRoute } from "./routes/geocode";
import { gtfsRoute } from "./routes/gtfs";
import { mapillaryRoute } from "./routes/mapillary";
import { motisRoute } from "./routes/motis";
import { placesRoute } from "./routes/places";
import { streetviewRoute } from "./routes/streetview";
import { trafficRoute } from "./routes/traffic";
import { transitRoute } from "./routes/transit";
import { evChargingProvider } from "./services/data-sources/ev-charging/provider";
import { fuelProvider } from "./services/data-sources/fuel/provider";
import { dataSourceRegistry } from "./services/data-sources/registry";
import { bikeSharingProvider } from "./services/data-sources/shared-mobility/bike-sharing-provider";
import { carSharingProvider } from "./services/data-sources/shared-mobility/car-sharing-provider";
import { scooterSharingProvider } from "./services/data-sources/shared-mobility/scooter-provider";
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

await server.register(helmet);
await server.register(cors, {
  origin: (process.env.CORS_ORIGIN ?? "http://localhost:3000").split(",").map((o) => o.trim()),
  credentials: true,
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

// Routes
await server.register(geocodeRoute, { prefix: "/api" });
await server.register(autocompleteRoute, { prefix: "/api" });
await server.register(placesRoute, { prefix: "/api" });
await server.register(categorySearchRoute, { prefix: "/api" });
await server.register(directionsRoute, { prefix: "/api" });
await server.register(trafficRoute, { prefix: "/api" });
await server.register(streetviewRoute, { prefix: "/api" });
await server.register(airQualityRoute, { prefix: "/api" });
await server.register(mapillaryRoute, { prefix: "/api" });
await server.register(transitRoute, { prefix: "/api" });
await server.register(gtfsRoute, { prefix: "/api" });
await server.register(motisRoute, { prefix: "/api" });
await server.register(dataSourcesRoute, { prefix: "/api" });

// Data source providers
dataSourceRegistry.register(evChargingProvider);
dataSourceRegistry.register(fuelProvider);
dataSourceRegistry.register(bikeSharingProvider);
dataSourceRegistry.register(scooterSharingProvider);
dataSourceRegistry.register(carSharingProvider);

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

// Debug endpoint: list loaded dynamic transit providers
server.get("/api/transit/registry", async () => ({
  entries: registry.listEntries(),
  count: registry.entryCount,
}));

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
    await server.close();
    await redis?.disconnect();
    await sql.end();
    process.exit(0);
  });
}

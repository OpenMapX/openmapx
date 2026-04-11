import { existsSync } from "node:fs";
import { join } from "node:path";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import { registry } from "@integrations/transit-dynamic-registry/registry";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import Fastify from "fastify";
import { auth } from "./auth";
import { db, sql } from "./db/index";
import {
  getAllIntegrations,
  initIntegrations,
  reloadIntegrations,
  shutdownIntegrations,
} from "./integration-host";
import { redis } from "./redis";
import { adminRoute } from "./routes/admin";
import { adminServicesRoute } from "./routes/admin-services";
import { adminSettingsRoute } from "./routes/admin-settings";
import { adminStoreRoute } from "./routes/admin-store";
import { capabilitiesRoute } from "./routes/capabilities";
import { categorySearchRoute } from "./routes/category-search";
import { dataSourcesRoute } from "./routes/data-sources";
import { elevationRoute } from "./routes/elevation";
import { gtfsRoute } from "./routes/gtfs";
import { imageProxyRoute } from "./routes/image-proxy";
import { isochroneRoute } from "./routes/isochrone";
import { mapillaryRoute } from "./routes/mapillary";
import { motisRoute } from "./routes/motis";
import { placesRoute } from "./routes/places";
import { risMapsRoute } from "./routes/ris-maps";
import { savedRoute } from "./routes/saved";
import { statusRoute } from "./routes/status";
import { tilesRoute } from "./routes/tiles";
import { trafficRoute } from "./routes/traffic";
import { transitRoute } from "./routes/transit";
import { winterSportsRoute } from "./routes/winter-sports";
import {
  buildTarget,
  profileStart,
  profileStop,
  serviceRestart,
  serviceStart,
  serviceStop,
} from "./services/admin-ops";
import { appLogger } from "./services/app-logger";
import { gtfsManager } from "./services/gtfs/index";
import { pruneOldRecords } from "./services/health-history";
import { jobRunner } from "./services/job-runner";
import { motisManager } from "./services/motis/manager";
import { handleInstallJob, handleRemoveJob, handleUpdateJob } from "./services/store";

const { default: pino } = await import("pino");
const server = Fastify({
  loggerInstance: pino(
    { level: process.env.LOG_LEVEL ?? "info" },
    pino.multistream([{ stream: process.stdout }, { stream: appLogger.createPinoStream() }]),
  ),
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
await server.register(placesRoute, { prefix: "/api" });
await server.register(categorySearchRoute, { prefix: "/api" });
await server.register(elevationRoute, { prefix: "/api" });
await server.register(trafficRoute, { prefix: "/api" });
await server.register(tilesRoute, { prefix: "/api" });
await server.register(mapillaryRoute, { prefix: "/api" });
await server.register(transitRoute, { prefix: "/api" });
await server.register(gtfsRoute, { prefix: "/api" });
await server.register(isochroneRoute, { prefix: "/api" });
await server.register(motisRoute, { prefix: "/api" });
await server.register(dataSourcesRoute, { prefix: "/api" });
await server.register(imageProxyRoute, { prefix: "/api" });
await server.register(winterSportsRoute, { prefix: "/api" });
await server.register(risMapsRoute, { prefix: "/api" });
await server.register(savedRoute, { prefix: "/api" });
await server.register(statusRoute, { prefix: "/api" });
await server.register(adminRoute, { prefix: "/api" });
await server.register(adminServicesRoute, { prefix: "/api" });
await server.register(adminSettingsRoute, { prefix: "/api" });
await server.register(adminStoreRoute, { prefix: "/api" });

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

// Initialize job runner (picks up interrupted jobs from previous run)
await jobRunner.initialize();

// Prune old health history records daily
setInterval(
  () =>
    void pruneOldRecords(30).catch((err) => server.log.warn(err, "Health history prune failed")),
  24 * 60 * 60 * 1000,
);

// Register job handlers
jobRunner.register("service.start", async (ctx) => {
  const service = ctx.payload.service as string;
  await serviceStart(service, ctx);
  return { service, action: "start" };
});

jobRunner.register("service.stop", async (ctx) => {
  const service = ctx.payload.service as string;
  await serviceStop(service, ctx);
  return { service, action: "stop" };
});

jobRunner.register("service.restart", async (ctx) => {
  const service = ctx.payload.service as string;
  await serviceRestart(service, ctx);
  return { service, action: "restart" };
});

jobRunner.register("profile.start", async (ctx) => {
  const profile = ctx.payload.profile as string;
  await profileStart(profile, ctx);
  return { profile, action: "start" };
});

jobRunner.register("profile.stop", async (ctx) => {
  const profile = ctx.payload.profile as string;
  await profileStop(profile, ctx);
  return { profile, action: "stop" };
});

jobRunner.register("build.target", async (ctx) => {
  const target = ctx.payload.target as string;
  await buildTarget(target, ctx);
  return { target };
});

jobRunner.register("integration.reload", async (ctx) => {
  await ctx.log("Reloading all integrations...");
  const result = await reloadIntegrations();
  await ctx.log(`Reload complete. Reloaded: ${result.reloaded}, Enabled: ${result.enabled}`);
  return result as Record<string, unknown>;
});

jobRunner.register("store.install", handleInstallJob);
jobRunner.register("store.update", handleUpdateJob);
jobRunner.register("store.remove", handleRemoveJob);

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

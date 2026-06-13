import { existsSync } from "node:fs";
import { join } from "node:path";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import { registry } from "@integrations/transit-dynamic-registry/registry";
import { listIdSchemeViews, registerBuiltinIdSchemeViews } from "@openmapx/place-ids";
import { fromNodeHeaders } from "better-auth/node";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import Fastify, { type FastifyError } from "fastify";
import { auth } from "./auth";
import { db, sql } from "./db/index";
import {
  getAllIntegrations,
  initIntegrations,
  reloadIntegrations,
  setDisallowedIntegrationResolver,
  setDisallowedSourceResolver,
  setIntegrationsReloadedHook,
  shutdownIntegrations,
} from "./integration-host";
import { redis } from "./redis";
import { adminRoute } from "./routes/admin";
import { registerCapabilityBindingRoutes } from "./routes/admin-capability-bindings";
import { registerAdminComposeRoutes } from "./routes/admin-compose";
import { registerAdminServiceReposRoutes } from "./routes/admin-service-repos";
import { adminServicesRoute } from "./routes/admin-services";
import { adminSettingsRoute } from "./routes/admin-settings";
import { adminStoreRoute } from "./routes/admin-store";
import { attributionRoute } from "./routes/attribution";
import { capabilitiesRoute } from "./routes/capabilities";
import { dataManagerRoute } from "./routes/data-manager";
import { elevationRoute } from "./routes/elevation";
import { gtfsRoute } from "./routes/gtfs";
import { imageProxyRoute } from "./routes/image-proxy";
import { internalMetricsRoute } from "./routes/internal-metrics";
import { internalPoiSourcesRoute } from "./routes/internal-poi-sources";
import { isochroneRoute } from "./routes/isochrone";
import { legalConfigRoute } from "./routes/legal-config";
import { maptilerRoute } from "./routes/maptiler";
import { motisRoute } from "./routes/motis";
import { neighborhoodsRoute } from "./routes/neighborhoods";
import { placesRoute } from "./routes/places";
import { reviewsKeypairRoute } from "./routes/reviews-keypair";
import { savedRoute } from "./routes/saved";
import { statusRoute } from "./routes/status";
import { tilesRoute } from "./routes/tiles";
import { trafficRoute } from "./routes/traffic";
import { winterSportsRoute } from "./routes/winter-sports";
import { pruneAuditLog, pruneCompletedJobs } from "./services/activity-retention";
import {
  handleBackupOperationJob,
  handleDataOperationJob,
  handleServiceBulkJob,
} from "./services/admin-job-handlers";
import { serviceRestart, serviceStart, serviceStop } from "./services/admin-ops";
import { appLogger } from "./services/app-logger";
import {
  filterGatedSources,
  getGatedIntegrationIds,
  getGatedSourceIds,
  getGatedSourceIdsSync,
  invalidateDataUsePolicy,
  refreshDataUsePolicy,
  startDataUsePolicyRefresh,
} from "./services/data-use-policy";
import { gtfsManager } from "./services/gtfs/index";
import { pruneOldRecords } from "./services/health-history";
import { jobRunner } from "./services/job-runner";
import { motisManager } from "./services/motis/manager";
import { initServiceRegistry } from "./services/service-registry";
import { handleInstallJob, handleRemoveJob, handleUpdateJob } from "./services/store";
import {
  authLimit,
  expensivePublicApiLimit,
  publicApiLimit,
  tilePublicApiLimit,
} from "./utils/rate-limit";
import { requireAuth } from "./utils/require-auth.js";

// Trust proxy hops in front of the API. The default deployment terminates TLS
// at Traefik (one hop) and forwards to this container, so `request.ip` must be
// derived from the leftmost untrusted X-Forwarded-For entry rather than from
// the socket peer (which would always be the proxy). Without this, IP-keyed
// rate limits collapse to a single bucket per upstream proxy.
//
// SECURITY: never set this to `true` (trust everyone) on a public deployment
// — that would let any client spoof their IP via X-Forwarded-For and bypass
// rate limits, audit attribution, and the loopback admin short-circuit. Set
// `TRUST_PROXY_HOPS` to the *exact* number of proxies between the public
// internet and this process (default 1 = one Traefik hop). Set it to `0` for
// direct exposure (development).
function trustProxyConfig(): number | boolean {
  const raw = process.env.TRUST_PROXY_HOPS?.trim();
  if (raw === undefined || raw === "") return 1; // default: assume one Traefik hop
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(
      `TRUST_PROXY_HOPS must be a non-negative integer (got "${raw}"). Use 0 for direct exposure, 1 for a single reverse proxy (default).`,
    );
  }
  return n;
}

const { default: pino } = await import("pino");
const server = Fastify({
  loggerInstance: pino(
    { level: process.env.LOG_LEVEL ?? "info" },
    pino.multistream([{ stream: process.stdout }, { stream: appLogger.createPinoStream() }]),
  ),
  trustProxy: trustProxyConfig(),
  routerOptions: {
    // DB HAFAS trip IDs can be ~300 chars when URL-encoded (default is 100)
    maxParamLength: 500,
  },
  // Review image uploads post base64 data URLs up to ~6.7 MB for a 5 MB photo
  // (4/3 base64 inflation). The orchestrator clamps the decoded size at 5 MB.
  bodyLimit: 10 * 1024 * 1024,
});

// Defense in depth against double-sends. The systemic cause is gone — the
// data-use-policy preSerialization hook is now synchronous, so a handler that
// sends then returns undefined no longer races a second send — but a future
// async hook could re-arm it. If a stray second write ever throws
// ERR_HTTP_HEADERS_SENT from Fastify's serialization continuation (outside any
// route try/catch), survive that one error: the first response already wrote
// correctly; only the stray second write fails. Everything else stays fail-fast.
//
// The error can surface on EITHER channel — uncaughtException, or
// unhandledRejection if any dependency registers its own unhandledRejection
// listener (which suppresses Node's default promotion to uncaughtException) — so
// guard both with the same handler.
function onFatal(err: unknown): void {
  if ((err as NodeJS.ErrnoException | undefined)?.code === "ERR_HTTP_HEADERS_SENT") {
    server.log.error(
      { err },
      "Suppressed ERR_HTTP_HEADERS_SENT (double send) — response dropped, process kept alive",
    );
    return;
  }
  server.log.fatal({ err }, "Fatal uncaught error — exiting");
  process.exit(1);
}
process.on("uncaughtException", onFatal);
process.on("unhandledRejection", onFatal);

// Uniform error body. Throwing handlers/guards (requireAuth/requireAdmin throw
// httpError, route validation throws with statusCode) would otherwise serialize
// via Fastify's default to `{ statusCode, error: "<HTTP phrase>", message }` —
// but every client reads `body.error` for the human-readable text, so a thrown
// 401 would show "Unauthorized" instead of "Authentication required". Restore
// the legacy `{ error: <message> }` shape for 4xx (matching the routes that
// still send it by hand), and never leak an internal 5xx message.
server.setErrorHandler((error: FastifyError, request, reply) => {
  const statusCode = error.statusCode ?? 500;
  if (statusCode >= 500) {
    request.log.error({ err: error }, "Request error");
    return reply.status(statusCode).send({ error: "Internal Server Error" });
  }
  return reply.status(statusCode).send({ error: error.message });
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

// Global rate limiting for the public surface.
//
// Skips:
//   - `/health` — used by Docker/Traefik healthchecks at high frequency.
//   - Loopback socket peers — the CLI and admin sweeps run locally; admin
//     endpoints layer their own per-action limiters on top (see `admin.ts`,
//     `admin-store.ts`, `admin-services.ts`, `admin-settings.ts`). We read
//     `socket.remoteAddress` here, not `request.ip`, so a public client
//     cannot forge XFF to bypass the limit (see `require-admin.ts`).
//
// Tiers, applied in order:
//   - `/api/auth/*`              → strict (credential stuffing, email spam)
//   - tile / map asset routes    → generous (bursty, cacheable, CDN-friendly)
//   - expensive public routes    → tight (Valhalla, MOTIS, geocoding fan-out)
//   - everything else            → broad floor
//
// Tile-ish routes get their own tier because a single viewport change can
// fan out 30-60 requests; sharing a bucket with the rest of the API would
// let map panning starve unrelated traffic (autocomplete, place lookups).
const TILE_PUBLIC_PATTERNS = [
  /^\/api\/maptiler\//,
  /^\/api\/tiles\//,
  /^\/api\/traffic\//,
  /^\/api\/integrations\/street-view-mapillary\/tiles\//,
];

const EXPENSIVE_PUBLIC_PATTERNS = [
  /^\/api\/isochrone(\/|$|\?)/,
  /^\/api\/elevation(\/|$|\?)/,
  /^\/api\/motis(\/|$)/,
  /^\/api\/places(\/|$|\?)/,
  /^\/api\/image-proxy(\/|$|\?)/,
  /^\/api\/winter-sports(\/|$)/,
  /^\/api\/integrations\/search-nlp(\/|$|\?)/,
];

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

const publicLimit = publicApiLimit.preHandler();
const expensiveLimit = expensivePublicApiLimit.preHandler();
const tileLimit = tilePublicApiLimit.preHandler();
const authRateLimit = authLimit.preHandler();

server.addHook("onRequest", async (request, reply) => {
  const url = request.url;
  if (url === "/health" || url.startsWith("/health?")) return;

  // Trust only the actual TCP peer here, never XFF.
  const peer = request.socket?.remoteAddress;
  if (peer && LOOPBACK.has(peer)) return;

  if (url.startsWith("/api/auth/")) {
    await authRateLimit(request, reply);
    return;
  }
  if (TILE_PUBLIC_PATTERNS.some((p) => p.test(url))) {
    await tileLimit(request, reply);
    return;
  }
  if (EXPENSIVE_PUBLIC_PATTERNS.some((p) => p.test(url))) {
    await expensiveLimit(request, reply);
    return;
  }
  if (url.startsWith("/api/")) {
    await publicLimit(request, reply);
  }
});

// Data-use policy: strip results sourced solely from policy-gated sources
// (non-commercial / grey-area) out of API responses. Admin + the integration
// registry/metadata endpoints are excluded so they keep listing every source
// for management and legal disclosure.
// Callback style (4 params incl. `done`) on purpose: with `done` invoked
// synchronously, Fastify never yields to the event loop mid-serialization, so a
// handler that sends then returns undefined can't race a second send. (An async
// hook — or even a 3-arg hook that returns the payload, which Fastify still
// awaits by arity — reopens that window and crashes the process.) Reading the
// gated set from the eagerly-warmed cache keeps every branch synchronous; the
// set is kept fresh by startDataUsePolicyRefresh() + invalidation.
server.addHook("preSerialization", (request, _reply, payload, done) => {
  const path = request.url.split("?")[0];
  if (
    path.startsWith("/api/admin") ||
    path.startsWith("/admin") ||
    path === "/api/integrations" ||
    path === "/api/integrations/health" ||
    path === "/api/transit/registry"
  ) {
    return done(null, payload);
  }
  if (!payload || typeof payload !== "object") return done(null, payload);
  const gated = getGatedSourceIdsSync();
  if (gated.size === 0) return done(null, payload);
  done(null, filterGatedSources(payload, gated));
});

// Let orchestrators (e.g. the weather chain) see the policy-gated source set so
// they can skip a gated provider and fall back to the next instead of returning
// data the response filter would only have to strip. The integration-keyed
// variant serves transit / knowledge, whose items aren't tagged with a `source`.
setDisallowedSourceResolver(getGatedSourceIds);
setDisallowedIntegrationResolver(getGatedIntegrationIds);
// Reloading integrations changes the source set the gated sets are derived
// from, so drop the policy's memoized gated sets when the registry is rebuilt
// and kick a refresh right away — the synchronous getters behind the response
// filter serve the last-good sets until a refresh replaces them. (The admin
// settings route does the same, awaited, on a policy-toggle change.)
setIntegrationsReloadedHook(() => {
  invalidateDataUsePolicy();
  void refreshDataUsePolicy().catch((err) => {
    server.log.warn(err, "Data-use policy refresh after integration reload failed");
  });
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
      return reply.send(response.status === 204 ? null : await response.text());
    } catch (error) {
      server.log.error(error, "Auth error");
      return reply.status(500).send({ error: "Internal authentication error" });
    }
  },
});

// Health check
server.get("/health", async () => ({ status: "ok" }));

// Capabilities (service availability)
await server.register(capabilitiesRoute, { prefix: "/api" });

// Public legal facts for the /privacy page (hosting provider, etc.)
await server.register(legalConfigRoute, { prefix: "/api" });

// Routes
await server.register(placesRoute, { prefix: "/api" });
await server.register(neighborhoodsRoute, { prefix: "/api" });

await server.register(elevationRoute, { prefix: "/api" });
await server.register(trafficRoute, { prefix: "/api" });
await server.register(tilesRoute, { prefix: "/api" });
await server.register(maptilerRoute, { prefix: "/api" });
await server.register(gtfsRoute, { prefix: "/api" });
await server.register(isochroneRoute, { prefix: "/api" });
await server.register(motisRoute, { prefix: "/api" });
await server.register(imageProxyRoute, { prefix: "/api" });
await server.register(internalMetricsRoute, { prefix: "/api" });
await server.register(internalPoiSourcesRoute, { prefix: "/api" });
await server.register(winterSportsRoute, { prefix: "/api" });
await server.register(reviewsKeypairRoute, { prefix: "/api" });
await server.register(savedRoute, { prefix: "/api" });
await server.register(statusRoute, { prefix: "/api" });
await server.register(adminRoute, { prefix: "/api" });
await server.register(adminServicesRoute, { prefix: "/api" });
await server.register(dataManagerRoute, { prefix: "/api" });
await server.register(adminSettingsRoute, { prefix: "/api" });
await server.register(adminStoreRoute, { prefix: "/api" });
await server.register(attributionRoute, { prefix: "/api" });
await registerCapabilityBindingRoutes(server);
await registerAdminServiceReposRoutes(server);
await registerAdminComposeRoutes(server);

// Session endpoint
server.get("/api/me", async (request, reply) => {
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

// Service registry — load service manifests from services/ directory
// Must run before initIntegrations so requires: blocks can be resolved
try {
  await initServiceRegistry();
  server.log.info("Service registry initialized");
} catch (err) {
  server.log.warn(err, "Service registry initialization failed (non-fatal)");
}

// Integration framework
// Built-ins are loaded from the immutable app-api image. Community integrations
// are loaded from a writable, bind-mounted runtime directory so admin/CLI
// installs survive app-api container replacement.
const runtimeRootDir = join(import.meta.dirname ?? ".", "..", "..", "..");
const integrationsDir = join(runtimeRootDir, "integrations");
const customIntegrationsDir =
  process.env.OPENMAPX_CUSTOM_INTEGRATIONS_DIR?.trim() ||
  join(runtimeRootDir, "custom_integrations");
// Register core-owned id-scheme views (OSM, Wikidata, social platforms,
// internal handles). Integrations can re-register their own schemes in
// their setup functions — registration is idempotent.
registerBuiltinIdSchemeViews();

await initIntegrations(server, [
  { directory: integrationsDir, isBuiltIn: true },
  { directory: customIntegrationsDir, isBuiltIn: false },
]);

// Debug endpoint — returns every registered id-scheme view. Replaces the
// value a static `PLACE_ID_SCHEMES` constant used to carry; reflects what
// integrations actually registered at boot.
server.get("/api/id-schemes", async () =>
  listIdSchemeViews().map(({ buildUrl, ...view }) => ({
    ...view,
    linkable: typeof buildUrl === "function",
  })),
);

// Initialize job runner (picks up interrupted jobs from previous run)
await jobRunner.initialize();

// Prune old health history records daily
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const AUDIT_RETENTION_DAYS = Number(process.env.AUDIT_LOG_RETENTION_DAYS ?? 90);
const JOB_RETENTION_DAYS = Number(process.env.ADMIN_JOB_RETENTION_DAYS ?? 30);

setInterval(
  () =>
    void pruneOldRecords(30).catch((err) => server.log.warn(err, "Health history prune failed")),
  ONE_DAY_MS,
);

setInterval(() => {
  void pruneAuditLog(AUDIT_RETENTION_DAYS).catch((err) =>
    server.log.warn(err, "Audit log prune failed"),
  );
  void pruneCompletedJobs(JOB_RETENTION_DAYS).catch((err) =>
    server.log.warn(err, "Admin job prune failed"),
  );
}, ONE_DAY_MS);

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

jobRunner.register("data.operation", handleDataOperationJob);
jobRunner.register("backup.operation", handleBackupOperationJob);
jobRunner.register("service.bulk", handleServiceBulkJob);

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
server.get("/api/transit/registry", async (req) => {
  await requireAuth(req);
  return { entries: registry.listEntries(), count: registry.entryCount };
});

// Warm the data-use-policy cache now that integrations are loaded, so the
// synchronous preSerialization hook has the gated set ready before the first
// request — and start the background refresh.
await startDataUsePolicyRefresh();

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

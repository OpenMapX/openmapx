// Must run first: swap the process's global fetch onto the fixed standalone
// undici before any module captures or uses it (see undici-fetch.ts).
import "./undici-fetch";
import { existsSync } from "node:fs";
import { join } from "node:path";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import { registry } from "@integrations/transit-dynamic-registry/registry";
import { listIdSchemeViews, registerBuiltinIdSchemeViews } from "@openmapx/place-ids";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import Fastify from "fastify";
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
import { adminCacheRoute } from "./routes/admin-cache";
import { registerCapabilityBindingRoutes } from "./routes/admin-capability-bindings";
import { registerAdminComposeRoutes } from "./routes/admin-compose";
import { adminExtensionsRoute } from "./routes/admin-extensions";
import { adminServicesRoute } from "./routes/admin-services";
import { adminSettingsRoute } from "./routes/admin-settings";
import { adminSystemRoute } from "./routes/admin-system";
import { attributionRoute } from "./routes/attribution";
import { capabilitiesRoute } from "./routes/capabilities";
import { dataManagerRoute } from "./routes/data-manager";
import { elevationRoute } from "./routes/elevation";
import { imageProxyRoute } from "./routes/image-proxy";
import { internalMetricsRoute } from "./routes/internal-metrics";
import { internalPoiSourcesRoute } from "./routes/internal-poi-sources";
import { isochroneRoute } from "./routes/isochrone";
import { legalConfigRoute } from "./routes/legal-config";
import { maptilerRoute } from "./routes/maptiler";
import { meRoute } from "./routes/me";
import { neighborhoodsRoute } from "./routes/neighborhoods";
import { offlinePackagesRoute } from "./routes/offline-packages";
import { placesRoute } from "./routes/places";
import { reviewsKeypairRoute } from "./routes/reviews-keypair";
import { savedRoute } from "./routes/saved";
import { statusRoute } from "./routes/status";
import { streetLevelRoute } from "./routes/street-level-imagery";
import { tilesRoute } from "./routes/tiles";
import { trafficRoute } from "./routes/traffic";
import { winterSportsRoute } from "./routes/winter-sports";
import {
  corsOptions,
  makeRateLimitTierHook,
  trustProxyConfig,
  uniformErrorHandler,
} from "./server-wiring";
import { pruneAuditLog, pruneCompletedJobs } from "./services/activity-retention";
import {
  handleBackupOperationJob,
  handleDataOperationJob,
  handleServiceBulkJob,
} from "./services/admin-job-handlers";
import { serviceApply, serviceRestart, serviceStart, serviceStop } from "./services/admin-ops";
import { currentAppApiRuntimeInfo } from "./services/app-api-replacement";
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
import {
  handleExtensionInstallJob,
  handleExtensionRemoveJob,
} from "./services/extension-installer";
import { pruneOldRecords } from "./services/health-history";
import { jobRunner } from "./services/job-runner";
import { initServiceRegistry } from "./services/service-registry";
import { handleSystemDiagnosticsJob, handleSystemUpdateJob } from "./services/system-maintenance";
import { envInt, envString } from "./utils/env";
import {
  authLimit,
  expensivePublicApiLimit,
  publicApiLimit,
  tilePublicApiLimit,
} from "./utils/rate-limit";
import { requireAuth } from "./utils/require-auth.js";

const { default: pino } = await import("pino");
const server = Fastify({
  loggerInstance: pino(
    { level: envString("LOG_LEVEL", "info") },
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
  const e = err as (NodeJS.ErrnoException & { stack?: string }) | undefined;
  if (e?.code === "ERR_HTTP_HEADERS_SENT") {
    server.log.error(
      { err },
      "Suppressed ERR_HTTP_HEADERS_SENT (double send) — response dropped, process kept alive",
    );
    return;
  }
  // undici's HTTP response parser can throw an assertion (e.g. "false == true"
  // from Parser.finish / Socket.onHttpSocketEnd) when an upstream server ends a
  // response with invalid HTTP framing. It surfaces as an uncaughtException off
  // the socket, escaping the originating fetch's try/catch, so it can't be
  // handled at the call site. It is an isolated client-side parse fault of one
  // outbound request — no app state is corrupted — so drop it and keep serving
  // instead of crash-looping. Observed with flaky third-party GBFS feeds during
  // shared-mobility fanout.
  if (e?.code === "ERR_ASSERTION" && /undici/.test(e.stack ?? "")) {
    server.log.error(
      { err },
      "Suppressed undici HTTP-parser assertion (flaky upstream) — request dropped, process kept alive",
    );
    return;
  }
  server.log.fatal({ err }, "Fatal uncaught error — exiting");
  process.exit(1);
}
process.on("uncaughtException", onFatal);
process.on("unhandledRejection", onFatal);

server.setErrorHandler(uniformErrorHandler);

// Run database migrations on startup (idempotent — skips already-applied migrations)
const migrationsDir = join(import.meta.dirname ?? ".", "db", "migrations");
let migrationsSucceeded = true;
if (existsSync(migrationsDir)) {
  try {
    await migrate(db, { migrationsFolder: migrationsDir });
    server.log.info("Database migrations applied");
  } catch (err) {
    migrationsSucceeded = false;
    server.log.error(err, "Database migration failed");
  }
}

await server.register(helmet);
await server.register(cors, corsOptions());

server.addHook(
  "onRequest",
  makeRateLimitTierHook({
    auth: authLimit.preHandler(),
    tile: tilePublicApiLimit.preHandler(),
    expensive: expensivePublicApiLimit.preHandler(),
    public: publicApiLimit.preHandler(),
  }),
);

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
await server.register(offlinePackagesRoute, { prefix: "/api" });

await server.register(elevationRoute, { prefix: "/api" });
await server.register(trafficRoute, { prefix: "/api" });
await server.register(tilesRoute, { prefix: "/api" });
await server.register(streetLevelRoute, { prefix: "/api" });
await server.register(maptilerRoute, { prefix: "/api" });
await server.register(isochroneRoute, { prefix: "/api" });
await server.register(imageProxyRoute, { prefix: "/api" });
await server.register(internalMetricsRoute, { prefix: "/api" });
await server.register(internalPoiSourcesRoute, { prefix: "/api" });
await server.register(winterSportsRoute, { prefix: "/api" });
await server.register(reviewsKeypairRoute, { prefix: "/api" });
await server.register(savedRoute, { prefix: "/api" });
await server.register(meRoute, { prefix: "/api" });
await server.register(statusRoute, { prefix: "/api" });
await server.register(adminRoute, { prefix: "/api" });
await server.register(adminServicesRoute, { prefix: "/api" });
await server.register(dataManagerRoute, { prefix: "/api" });
await server.register(adminSettingsRoute, { prefix: "/api" });
await server.register(adminExtensionsRoute, { prefix: "/api" });
await server.register(adminCacheRoute, { prefix: "/api" });
await server.register(adminSystemRoute, { prefix: "/api" });
await server.register(attributionRoute, { prefix: "/api" });
await registerCapabilityBindingRoutes(server);
await registerAdminComposeRoutes(server);

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

// Prune old health history records daily
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const AUDIT_RETENTION_DAYS = envInt("AUDIT_LOG_RETENTION_DAYS", 90);
const JOB_RETENTION_DAYS = envInt("ADMIN_JOB_RETENTION_DAYS", 30);

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

jobRunner.register("service.apply", async (ctx) => {
  const service = ctx.payload.service as string;
  await serviceApply(service, ctx);
  return { service, action: "apply" };
});

jobRunner.register("data.operation", handleDataOperationJob);
jobRunner.register("backup.operation", handleBackupOperationJob);
jobRunner.register("service.bulk", handleServiceBulkJob);
jobRunner.register("system.update", handleSystemUpdateJob);
jobRunner.register("system.diagnostics", handleSystemDiagnosticsJob);

jobRunner.register("integration.reload", async (ctx) => {
  await ctx.log("Reloading all integrations...");
  const result = await reloadIntegrations();
  await ctx.log(`Reload complete. Reloaded: ${result.reloaded}, Enabled: ${result.enabled}`);
  return result as Record<string, unknown>;
});

jobRunner.register("extension.install", handleExtensionInstallJob);
jobRunner.register("extension.remove", handleExtensionRemoveJob);

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

const port = envInt("PORT", 3000);
const host = envString("HOST", "0.0.0.0");

try {
  await server.listen({ port, host });
} catch (err) {
  server.log.error(err);
  process.exit(1);
}

// Only complete a checkpointed self-update after the replacement API is
// genuinely listening, migrations succeeded, and Docker confirms that this
// process is running the exact image pulled by the update job.
await jobRunner.initialize({
  completeRestartedUpdates: migrationsSucceeded,
  currentAppApiRuntime: await currentAppApiRuntimeInfo(),
});

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

// Must run first: swap the process's global fetch onto the fixed standalone
// undici before any module captures or uses it (see undici-fetch.ts).
import "./undici-fetch";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import { createFatalProcessHandler, findRepoRoot } from "@openmapx/core/server";
import { registerBuiltinIdSchemeViews } from "@openmapx/place-ids";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import Fastify from "fastify";
import { auth } from "./auth";
import { db, sql } from "./db/index";
import { installedExtension } from "./db/schema";
import {
  getAllIntegrations,
  initIntegrations,
  reloadIntegrations,
  setDisallowedIntegrationResolver,
  setDisallowedSourceResolver,
  setIntegrationsReloadedHook,
  shutdownIntegrations,
} from "./integration-host";
import { setIntegrationRouteRateLimits } from "./integration-routes";
import { redis } from "./redis";
import { registerCoreRoutes } from "./routes/index";
import {
  controlledRequestLoggingOptions,
  corsOptions,
  makeRateLimitTierHook,
  makeSecurityResponseHeaderHook,
  makeStatusAwareRateLimit,
  makeTimelineAwareRateLimit,
  registerControlledRequestLogging,
  trustProxyConfig,
  uniformErrorHandler,
} from "./server-wiring";
import { pruneAuditLog, pruneCompletedJobs } from "./services/activity-retention";
import {
  handleBackupOperationJob,
  handleDataOperationJob,
  handleServiceBulkJob,
} from "./services/admin-job-handlers";
import {
  renderAndPersistCompose,
  serviceApply,
  serviceRestart,
  serviceStart,
  serviceStop,
} from "./services/admin-ops";
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
import { reconcileExtensionInstallJournals } from "./services/extension-install-journal";
import {
  handleExtensionInstallJob,
  handleExtensionRemoveJob,
} from "./services/extension-installer";
import { pruneOldRecords } from "./services/health-history";
import { jobRunner } from "./services/job-runner";
import { createDurableOpsKey } from "./services/ops-client";
import { openRuntimeRecoveryAuthority } from "./services/runtime-recovery-authority";
import {
  mergeRuntimeRecovery,
  type RuntimeRecoveryRecord,
} from "./services/runtime-recovery-journal";
import { initServiceRegistry } from "./services/service-registry";
import { reconcileRepoBackups } from "./services/service-repositories";
import { reconcileDurableServiceRuntime } from "./services/service-runtime-recovery";
import { handleSystemDiagnosticsJob, handleSystemUpdateJob } from "./services/system-maintenance";
import { applyTrustedConfiguration } from "./services/trusted-config-operations";
import { applyRequiredMigrations } from "./startup-migrations";
import { configuredTrustedWebOrigins, makeCsrfGuardHook } from "./utils/csrf";
import { dockerComposeAction } from "./utils/docker-compose";
import { envInt, envString } from "./utils/env";
import {
  authLimit,
  expensivePublicApiLimit,
  publicApiLimit,
  statusPublicApiLimit,
  tilePublicApiLimit,
} from "./utils/rate-limit";
import { createSafePinoOptions } from "./utils/safe-log-fields";

const { default: pino } = await import("pino");
const loggerInstance = pino(
  createSafePinoOptions(envString("LOG_LEVEL", "info")),
  pino.multistream([{ stream: process.stdout }, { stream: appLogger.createPinoStream() }]),
);
const server = Fastify({
  ...controlledRequestLoggingOptions(loggerInstance),
  trustProxy: trustProxyConfig(),
  routerOptions: {
    // DB HAFAS trip IDs can be ~300 chars when URL-encoded (default is 100)
    maxParamLength: 500,
  },
  // Review image uploads post base64 data URLs up to ~6.7 MB for a 5 MB photo
  // (4/3 base64 inflation). The orchestrator clamps the decoded size at 5 MB.
  bodyLimit: 10 * 1024 * 1024,
});

registerControlledRequestLogging(server);

// No exception shape proves a process is safe to keep serving after control
// reaches a fatal channel. The pinned standalone Undici contains the historical
// parser fix, and structural route tests cover the former double-send cause.
// Terminate uniformly and let the container restart through mandatory startup
// migration/reconciliation rather than continuing with unknown shared state.
const onFatal = createFatalProcessHandler({
  fatal: (fields, message) => server.log.fatal(fields, message),
  exit: (code) => process.exit(code),
});
process.on("uncaughtException", onFatal);
process.on("unhandledRejection", onFatal);

server.setErrorHandler(uniformErrorHandler);

// Run database migrations on startup (idempotent — skips already-applied migrations)
const migrationsDir = join(import.meta.dirname ?? ".", "db", "migrations");
try {
  await applyRequiredMigrations({
    migrationsDirectory: migrationsDir,
    directoryExists: existsSync,
    migrate: () => migrate(db, { migrationsFolder: migrationsDir }),
  });
  server.log.info("Database migrations applied");
} catch (err) {
  // Never bind a socket against an unknown schema. A failed deployment must be
  // visible to the orchestrator as a stopped container, not as a healthy API
  // that turns schema mismatches into request-time errors or partial writes.
  server.log.fatal(err, "Required database migration failed; refusing to start");
  throw err;
}

try {
  await reconcileExtensionInstallJournals(findRepoRoot(), async (journal) => {
    const [row] = await db
      .select({ manifest: installedExtension.manifest })
      .from(installedExtension)
      .where(eq(installedExtension.id, journal.extensionId))
      .limit(1);
    return !!row && isDeepStrictEqual(row.manifest, journal.targetManifest);
  });
  server.log.info("Extension integration install journals reconciled");
  const root = findRepoRoot();
  const runtimeRecoveryJournal = await openRuntimeRecoveryAuthority(root);
  const serviceRecovery = await reconcileRepoBackups({
    restoreSelection: async (roots, recoveryId) => {
      await initServiceRegistry();
      await applyTrustedConfiguration({
        kind: "serviceSelection.apply",
        selectedRoots: roots,
        operationKey: createDurableOpsKey("startup.selection.recovery", recoveryId),
      });
    },
    persistRuntimeRecovery: async (recovery) => {
      if (!recovery.incidentId) {
        throw new Error("Service runtime recovery is missing its durable incident identity");
      }
      const discovered: RuntimeRecoveryRecord = {
        version: 1,
        incidentId: recovery.incidentId,
        orphanedServiceIds: [...recovery.orphanedServiceIds],
        restartServiceIds: [...recovery.restartServiceIds],
      };
      const retained = runtimeRecoveryJournal.record();
      await runtimeRecoveryJournal.replace(
        retained === null ? discovered : mergeRuntimeRecovery(retained, discovered),
      );
    },
  });
  await reconcileDurableServiceRuntime(serviceRecovery, runtimeRecoveryJournal, {
    // Startup runtime recovery uses the same typed operations as every other
    // lifecycle path, so recovery never needs a Docker socket either.
    remove: (serviceId) =>
      dockerComposeAction(serviceId, "remove", {
        operationKey: createDurableOpsKey(
          "startup.runtime-recovery.remove",
          `${serviceRecovery.incidentId ?? "recovery-without-incident"}:${serviceId}`,
        ),
      }),
    recreate: (serviceId) =>
      dockerComposeAction(serviceId, "recreate-isolated", {
        operationKey: createDurableOpsKey(
          "startup.runtime-recovery.recreate",
          `${serviceRecovery.incidentId ?? "recovery-without-incident"}:${serviceId}`,
        ),
      }),
    initializeRegistry: initServiceRegistry,
    renderCompose: () =>
      renderAndPersistCompose({
        operationKey: createDurableOpsKey(
          "startup.runtime-recovery.render",
          serviceRecovery.incidentId ?? "recovery-without-incident",
        ),
      }),
  });
  server.log.info("Service repository rollbacks reconciled");
} catch (err) {
  server.log.fatal(err, "Service repository rollback reconciliation failed; refusing to start");
  throw err;
}

const trustedWebOrigins = configuredTrustedWebOrigins();

await server.register(helmet);
await server.register(cors, corsOptions(trustedWebOrigins));

server.addHook("onRequest", makeSecurityResponseHeaderHook());
server.addHook("onRequest", makeCsrfGuardHook(trustedWebOrigins));
const rateLimitTiers = {
  auth: authLimit.preHandler(),
  tile: tilePublicApiLimit.preHandler(),
  expensive: makeTimelineAwareRateLimit(expensivePublicApiLimit),
  status: makeStatusAwareRateLimit(statusPublicApiLimit),
  public: makeTimelineAwareRateLimit(publicApiLimit),
};
setIntegrationRouteRateLimits(rateLimitTiers);
server.addHook("onRequest", makeRateLimitTierHook(rateLimitTiers));

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

// Every route that isn't contributed by an integration, in one place — see
// `routes/index.ts`. The OpenAPI generator mounts this same function on a bare
// Fastify instance, so a core route registered anywhere else would be missing
// from the committed `openapi.json`.
await registerCoreRoutes(server, {
  authHandler: auth.handler,
  authUiOrigin: trustedWebOrigins[0],
});

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
await jobRunner.initialize();

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

import {
  handlePreparedArtifactExportJob,
  handlePreparedArtifactImportJob,
  handlePreparedArtifactValidationJob,
} from "./services/admin-artifact-validation";
import { handleBackupPruneJob } from "./services/admin-backup-maintenance";
import { handleComposeRenderJob } from "./services/admin-compose-render";
import { handleImageStageJob } from "./services/admin-image-staging";
import { handleReleaseClearJob } from "./services/admin-release-controls";
import "@openmapx/core/undici-fetch";
import { existsSync } from "node:fs";
import { join } from "node:path";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import { compactErasureJournal } from "@openmapx/core/erasure-journal";
import { envInt, envString } from "@openmapx/core/server-env";
import { registerBuiltinIdSchemeViews } from "@openmapx/place-ids";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { startAccountMailWorker } from "./account/account-mail-outbox";
import { auth } from "./auth";
import { db, openMigrationSession, sql } from "./db/index";
import { type MigrationRun, startMigrations } from "./db/migration-runner";
import {
  getAllIntegrations,
  initIntegrations,
  reloadIntegrations,
  setDisallowedIntegrationResolver,
  setDisallowedSourceResolver,
  setInstalledIntegrationResolver,
  setIntegrationSourcesChangedHook,
  setRoadConditionsPolicyResolver,
  shutdownIntegrations,
  startAttributionLicenseWatch,
  startIntegrationHealthRefresh,
  stopIntegrationHealthRefresh,
} from "./integration-host";
import { setIntegrationRouteRateLimits } from "./integration-routes";
import { runPrivacyDatabaseCleanup } from "./privacy/cleanup.js";
import { schedulePrivacyDeadlineReminders } from "./privacy/deadline-reminders.js";
import { janitorEncryptedSourceSpools } from "./privacy/encrypted-source-spool.js";
import { createPrivacyNotificationWorker } from "./privacy/notifications.js";
import { createPrivacyOperationsMonitor } from "./privacy/operations-monitor.js";
import {
  cameraMediaSourcesOf,
  setCameraMediaSources,
  setGatedImageSourceResolver,
} from "./routes/image-hosts";
import { registerCoreRoutes } from "./routes/index";
import {
  controlledRequestLoggingOptions,
  corsOptions,
  makeRateLimitTierHook,
  makeSecurityResponseHeaderHook,
  makeStatusAwareRateLimit,
  makeTimelineAwareRateLimit,
  registerBodyReadDeadline,
  registerControlledRequestLogging,
  shutdownServer,
  trustProxyConfig,
  uniformErrorHandler,
} from "./server-wiring";
import {
  parseRequiredRetentionDays,
  pruneAppLogs,
  pruneAuditLog,
  pruneCompletedJobs,
  pruneDataManagerJobs,
  pruneExpiredVerifications,
} from "./services/activity-retention";
import {
  handleBackupOperationJob,
  handleDataOperationJob,
  handleServiceBulkJob,
} from "./services/admin-job-handlers";
import { validateAdminOperationCatalog } from "./services/admin-operation-catalog";
import { serviceApply, serviceRestart, serviceStart, serviceStop } from "./services/admin-ops";
import { readLoadableIntegrations } from "./services/agent-integrations";
import { appLogger } from "./services/app-logger";
import { cacheInvalidation } from "./services/cache-invalidation";
import {
  startMigrationStagePruning,
  stopMigrationStagePruning,
} from "./services/configuration-migration/staging";
import {
  filterGatedSources,
  getGatedIntegrationIds,
  getGatedSourceIds,
  getGatedSourceIdsSync,
  getRoadConditionsPolicySnapshot,
  invalidateDataUsePolicy,
  refreshDataUsePolicy,
  startDataUsePolicyRefresh,
  stopDataUsePolicyRefresh,
} from "./services/data-use-policy";
import {
  handleExtensionInstallJob,
  handleExtensionRemoveJob,
} from "./services/extension-installer";
import {
  recoverInterruptedExtensionChanges,
  withExtensionChangeLock,
} from "./services/extension-recovery";
import { pruneOldRecords } from "./services/health-history";
import {
  startAdminJobReconciliation,
  stopAdminJobReconciliation,
} from "./services/job-reconciliation";
import { jobRunner } from "./services/job-runner";
import { initServiceRegistry } from "./services/service-registry";
import { handleSystemDiagnosticsJob, handleSystemUpdateJob } from "./services/system-maintenance";
import { readJournalKey } from "./services/user-erasure.js";
import { applyRequiredMigrations } from "./startup-migrations";
import { configuredTrustedWebOrigins, makeCsrfGuardHook } from "./utils/csrf";
import {
  authLimit,
  expensivePublicApiLimit,
  integrationIngressApiLimit,
  publicApiLimit,
  routingApiLimit,
  statusPublicApiLimit,
  tilePublicApiLimit,
  typeaheadApiLimit,
  unmatchedRouteLimit,
} from "./utils/rate-limit";
import { createSafePinoOptions } from "./utils/safe-log-fields";

/** How the process entry point reaches a migration that is still running. */
export interface AppStartupControl {
  migrationStarted(run: MigrationRun): void;
  stopRequested(): boolean;
}

/**
 * Open event streams never end on their own, so shutdown cuts the connections
 * still open after this long. Both together stay under the ten seconds a
 * container runtime allows before it kills the process.
 */
const SHUTDOWN_GRACE_MS = 5_000;
const SHUTDOWN_FORCE_MS = 2_000;

export interface CreateAppOptions {
  /** Shared with the entry point's fatal handlers, which must exist before startup begins. */
  logger?: FastifyBaseLogger;
  startup?: AppStartupControl;
}

export interface App {
  server: FastifyInstance;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export async function createApiLogger(): Promise<FastifyBaseLogger> {
  const { default: pino } = await import("pino");
  return pino(
    createSafePinoOptions(envString("LOG_LEVEL", "info")),
    pino.multistream([{ stream: process.stdout }, { stream: appLogger.createPinoStream() }]),
  );
}

/**
 * Builds the complete application: schema, security hooks, routes, integrations
 * and job handlers. Listening, workers and timers belong to `start()`, with these
 * exceptions. Cache invalidation starts here because integrations need it before
 * they load; with Redis configured it holds a subscriber and a heartbeat until
 * `stop()`. Importing this module builds the auth singleton, whose OAuth plugin
 * requests OpenStreetMap's discovery document straight away. And integrations
 * run their `setup()` here, so any requests or timers they begin at setup start
 * too; `stop()` releases those timers through their shutdown handlers.
 */
export async function createApp(options: CreateAppOptions = {}): Promise<App> {
  const loggerInstance = options.logger ?? (await createApiLogger());
  const server = Fastify({
    ...controlledRequestLoggingOptions(loggerInstance),
    trustProxy: trustProxyConfig(),
    routerOptions: {
      // DB HAFAS trip IDs can be ~300 chars when URL-encoded (default is 100)
      maxParamLength: 500,
    },
    // Anything larger declares its own limit on the route (the saved import and
    // the review image upload do), so a route that never asked cannot be handed
    // a large body.
    bodyLimit: 1024 * 1024,
  });

  registerControlledRequestLogging(server);
  // Registered before every other request hook so a request that is rejected
  // early is still held to the deadline. Artifact uploads stream for as long as
  // the transfer takes, so they are exempt.
  registerBodyReadDeadline(server, {
    ms: 60_000,
    exemptRoutePrefixes: ["/api/admin/artifact-transfers"],
  });

  server.setErrorHandler(uniformErrorHandler);

  // Run database migrations on startup (idempotent — skips already-applied migrations)
  const migrationsDir = join(import.meta.dirname ?? ".", "db", "migrations");
  try {
    const migrationStartedAt = Date.now();
    let applied: string[] = [];
    await applyRequiredMigrations({
      migrationsDirectory: migrationsDir,
      directoryExists: existsSync,
      migrate: async () => {
        const migrationRun = startMigrations({
          session: openMigrationSession(),
          control: sql,
          migrationsFolder: migrationsDir,
          log: server.log,
        });
        options.startup?.migrationStarted(migrationRun);
        applied = await migrationRun.done;
      },
    });
    server.log.info(
      { migrations: applied, durationMs: Date.now() - migrationStartedAt },
      "Database migrations applied",
    );
  } catch (err) {
    if (options.startup?.stopRequested()) {
      server.log.warn(
        "Database migration stopped before it finished; it rolled back and runs again on the next start",
      );
      // The stop handler exits the process once the migration has rolled back.
      await new Promise<never>(() => {});
    }
    // Never bind a socket against an unknown schema. A failed deployment must be
    // visible to the orchestrator as a stopped container, not as a healthy API
    // that turns schema mismatches into request-time errors or partial writes.
    server.log.fatal(err, "Required database migration failed; refusing to start");
    throw err;
  }

  // Settle what an interrupted extension change left in the operations agent.
  // An unreachable agent must not keep the API down; every extension job runs
  // this recovery again before it changes anything.
  try {
    await withExtensionChangeLock(() => recoverInterruptedExtensionChanges());
    server.log.info("Interrupted extension changes recovered");
  } catch (err) {
    server.log.error(
      err,
      "Interrupted extension changes could not be recovered yet; extension jobs will retry",
    );
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
    routing: routingApiLimit.preHandler(),
    typeahead: typeaheadApiLimit.preHandler(),
    integrationIngress: integrationIngressApiLimit.preHandler(),
    status: makeStatusAwareRateLimit(statusPublicApiLimit),
    public: makeTimelineAwareRateLimit(publicApiLimit),
    unmatched: unmatchedRouteLimit.preHandler(),
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
  setRoadConditionsPolicyResolver(getRoadConditionsPolicySnapshot);
  setDisallowedIntegrationResolver(getGatedIntegrationIds);
  // The image proxy refuses a camera host whose only declaring sources the
  // policy disallows. It reads the last refreshed set on every request, so a
  // policy change reaches it with the same refresh as the response filter.
  setGatedImageSourceResolver(getGatedSourceIdsSync);
  // Reloading integrations, or a runtime integration replacing its data sources,
  // changes the source set the gated sets are derived from, so drop the policy's
  // memoized gated sets and kick a refresh right away — the synchronous getters
  // behind the response filter serve the last-good sets until a refresh replaces
  // them. (The admin settings route does the same, awaited, on a policy-toggle
  // change.)
  setIntegrationSourcesChangedHook(() => {
    // The image proxy admits a camera host only while a live source declares it.
    setCameraMediaSources(cameraMediaSourcesOf(getAllIntegrations()));
    invalidateDataUsePolicy();
    void refreshDataUsePolicy().catch((err) => {
      server.log.warn(err, "Data-use policy refresh after an integration source change failed");
    });
  });

  // Every route that isn't contributed by an integration, in one place — see
  // `routes/index.ts`. The OpenAPI generator mounts this same function on a bare
  // Fastify instance, so a core route registered anywhere else would be missing
  // from the committed `openapi.json`.
  let privacyCleanupProbe = { healthy: false, checkedAt: new Date(0).toISOString() };
  const privacyNotificationWorker = createPrivacyNotificationWorker({ database: db });
  const privacyOperationsMonitor = createPrivacyOperationsMonitor({
    database: db,
    cleanupHealthy: () => privacyCleanupProbe,
    notificationHealthy: () => {
      const notification = privacyNotificationWorker.health();
      if (!notification.lastRunAt) return { healthy: false, checkedAt: new Date(0).toISOString() };
      return { healthy: notification.healthy, checkedAt: notification.lastRunAt };
    },
    intervalMs: envInt("PRIVACY_MONITOR_INTERVAL_MS", 60_000),
  });

  await registerCoreRoutes(server, {
    authHandler: auth.handler,
    authUiOrigin: trustedWebOrigins[0],
  });

  // Case retention and the export source spool janitor run on their own loop,
  // independent of the broad activity cleanup below.
  const runPrivacyRetention = () => {
    void Promise.all([runPrivacyDatabaseCleanup({ database: db }), janitorEncryptedSourceSpools()])
      .then(() => {
        privacyCleanupProbe = { healthy: true, checkedAt: new Date().toISOString() };
      })
      .catch(() => {
        privacyCleanupProbe = { healthy: false, checkedAt: new Date().toISOString() };
        server.log.warn("Privacy retention cleanup failed");
      });
  };

  const privacyReminderIntervalMs = envInt("PRIVACY_DEADLINE_REMINDER_INTERVAL_MS", 5 * 60_000);
  if (privacyReminderIntervalMs < 60_000 || privacyReminderIntervalMs > 3_600_000)
    throw new Error("invalid privacy deadline reminder interval");
  const runPrivacyDeadlineReminders = () => {
    void schedulePrivacyDeadlineReminders({ database: db }).catch((err) =>
      server.log.warn(err, "Privacy deadline reminder scheduling failed"),
    );
  };

  // Service registry — load service manifests from services/ directory
  // Must run before initIntegrations so requires: blocks can be resolved
  try {
    await initServiceRegistry();
    server.log.info("Service registry initialized");
  } catch (err) {
    server.log.warn(err, "Service registry initialization failed (non-fatal)");
  }

  // Integration framework
  // Built-ins are loaded from the immutable app-api image. Installed integrations
  // are loaded from the bind-mounted host directory the operations agent owns
  // and app-api only reads. With an agent, only integrations it reports intact
  // are loaded, and their files are checked against the digests it recorded.
  const runtimeRootDir = join(import.meta.dirname ?? ".", "..", "..", "..");
  const integrationsDir = join(runtimeRootDir, "integrations");
  // The container always names its mount; an API run from the host checkout
  // reads the agent's integration store there directly.
  const customIntegrationsDir =
    process.env.OPENMAPX_CUSTOM_INTEGRATIONS_DIR?.trim() ||
    join(runtimeRootDir, "infra", "docker", "state", "ops-agent", "custom-integrations");
  setInstalledIntegrationResolver(() =>
    readLoadableIntegrations({
      // The agent was unreachable and now reports a different set.
      onChange: () => {
        reloadIntegrations().catch((err) =>
          server.log.warn(err, "Reloading integrations the operations agent reported failed"),
        );
      },
    }),
  );
  // Register core-owned id-scheme views (OSM, Wikidata, social platforms,
  // internal handles). Integrations can re-register their own schemes in
  // their setup functions — registration is idempotent.
  registerBuiltinIdSchemeViews();

  await cacheInvalidation.start();
  await initIntegrations(server, [
    { directory: integrationsDir, isBuiltIn: true },
    { directory: customIntegrationsDir, isBuiltIn: false },
  ]);
  // Runtime integrations supplied their first sources during setup, before
  // they were live, so the sources-changed hook has not run for them yet.
  setCameraMediaSources(cameraMediaSourcesOf(getAllIntegrations()));

  // Prune old health history records daily
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  const AUDIT_RETENTION_DAYS = envInt("AUDIT_LOG_RETENTION_DAYS", 90);
  const JOB_RETENTION_DAYS = envInt("ADMIN_JOB_RETENTION_DAYS", 30);
  const APP_LOG_RETENTION_DAYS = parseRequiredRetentionDays("LEGAL_SERVER_LOG_RETENTION_DAYS", 30);
  const BACKUP_RETENTION_DAYS = parseRequiredRetentionDays("BACKUP_RETENTION_DAYS", 30);

  const runRetention = () => {
    void pruneAuditLog(AUDIT_RETENTION_DAYS).catch((err) =>
      server.log.warn(err, "Audit log prune failed"),
    );
    void pruneCompletedJobs(JOB_RETENTION_DAYS).catch((err) =>
      server.log.warn(err, "Admin job prune failed"),
    );
    void pruneDataManagerJobs(JOB_RETENTION_DAYS).catch((err) =>
      server.log.warn(err, "Data-manager job prune failed"),
    );
    void pruneAppLogs(APP_LOG_RETENTION_DAYS).catch((err) =>
      server.log.warn(err, "Application log prune failed"),
    );
    void pruneExpiredVerifications().catch((err) =>
      server.log.warn(err, "Expired verification prune failed"),
    );
    const erasureJournalPath = process.env.ERASURE_JOURNAL_PATH?.trim();
    if (erasureJournalPath) {
      try {
        compactErasureJournal(
          erasureJournalPath,
          readJournalKey(),
          new Date(Date.now() - (BACKUP_RETENTION_DAYS + 7) * ONE_DAY_MS),
        );
      } catch (err) {
        server.log.warn(err, "Erasure journal compaction failed");
      }
    }
  };

  // Register job handlers
  validateAdminOperationCatalog();
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
  jobRunner.register("service.core-restart", async (ctx) => {
    const { runCoreServiceMaintenance } = await import("./services/core-service-maintenance");
    return runCoreServiceMaintenance(ctx);
  });

  jobRunner.register("service.apply", async (ctx) => {
    const service = ctx.payload.service as string;
    const result = await serviceApply(service, ctx);
    return { service, action: "apply", ...result };
  });

  jobRunner.register("data.operation", handleDataOperationJob);
  jobRunner.register("backup.operation", handleBackupOperationJob);
  jobRunner.register("service.bulk", handleServiceBulkJob);
  jobRunner.register("release.clear", handleReleaseClearJob);
  jobRunner.register("service.images.pull", handleImageStageJob);
  jobRunner.register("backup.prune", handleBackupPruneJob);
  jobRunner.register("compose.render", handleComposeRenderJob);
  jobRunner.register("artifact.validate", handlePreparedArtifactValidationJob);
  jobRunner.register("artifact.import", handlePreparedArtifactImportJob);
  jobRunner.register("artifact.export", handlePreparedArtifactExportJob);
  jobRunner.register("system.update", handleSystemUpdateJob);
  jobRunner.register("system.diagnostics", handleSystemDiagnosticsJob);

  jobRunner.register("integration.reload", async (ctx) => {
    await ctx.log("Reloading all integrations...");
    const result = await reloadIntegrations();
    await ctx.log(`Reload complete. Reloaded: ${result.reloaded}, Enabled: ${result.enabled}`);
    return result as Record<string, unknown>;
  });

  jobRunner.register("standalone.adopt", async (ctx) =>
    (await import("./services/standalone-integrations/ownership")).handleStandaloneOwnership(ctx),
  );
  jobRunner.register("standalone.remove", async (ctx) =>
    (await import("./services/standalone-integrations/ownership")).handleStandaloneOwnership(ctx),
  );
  jobRunner.register("standalone.preview", async (ctx) =>
    (await import("./services/standalone-integrations/install")).handleStandalonePreview(ctx),
  );
  jobRunner.register("standalone.install", async (ctx) =>
    (await import("./services/standalone-integrations/install")).handleStandaloneInstall(ctx),
  );
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
      throw new Error("No integrations loaded");
    }
  }
  server.log.info(`Loaded ${loadedCount} integrations`);

  let stopAccountMailWorker: (() => Promise<void>) | undefined;
  server.addHook("onClose", stopAdminJobReconciliation);
  server.addHook("onClose", async () => jobRunner.stopPumping());
  server.addHook("onClose", async () => {
    await stopAccountMailWorker?.();
  });

  const intervals: ReturnType<typeof setInterval>[] = [];

  async function start(): Promise<void> {
    // A crashed collector loses its ephemeral key; remove its owned ciphertext
    // spools as well. Active or ambiguous directories are never removed.
    await janitorEncryptedSourceSpools();

    startMigrationStagePruning();
    runPrivacyRetention();
    privacyNotificationWorker.start();
    privacyOperationsMonitor.start();

    runPrivacyDeadlineReminders();
    const privacyReminderTimer = setInterval(
      runPrivacyDeadlineReminders,
      privacyReminderIntervalMs,
    );
    privacyReminderTimer.unref?.();
    intervals.push(privacyReminderTimer);

    startAttributionLicenseWatch();
    startIntegrationHealthRefresh();

    intervals.push(
      setInterval(
        () =>
          void pruneOldRecords(30).catch((err) =>
            server.log.warn(err, "Health history prune failed"),
          ),
        ONE_DAY_MS,
      ),
    );

    runRetention();
    intervals.push(setInterval(runRetention, ONE_DAY_MS));
    // Expired keys and crash-orphaned encrypted source spools need a shorter
    // cleanup cadence than ordinary account activity.
    intervals.push(setInterval(runPrivacyRetention, 60 * 60_000).unref());

    // Warm the data-use-policy cache now that integrations are loaded, so the
    // synchronous preSerialization hook has the gated set ready before the first
    // request — and start the background refresh.
    await startDataUsePolicyRefresh();

    const port = envInt("PORT", 3000);
    const host = envString("HOST", "0.0.0.0");
    stopAccountMailWorker = startAccountMailWorker();

    try {
      await server.listen({ port, host });
    } catch (err) {
      server.log.error(err);
      throw err;
    }

    // Only complete a checkpointed self-update after the replacement API is
    // genuinely listening, migrations succeeded, and Docker confirms that this
    // process is running the exact image pulled by the update job.
    await jobRunner.initialize();
    startAdminJobReconciliation();
  }

  let stopping: Promise<void> | undefined;

  function stop(): Promise<void> {
    stopping ??= (async () => {
      privacyOperationsMonitor.stop();
      privacyNotificationWorker.stop();
      for (const interval of intervals) clearInterval(interval);
      stopMigrationStagePruning();
      stopIntegrationHealthRefresh();
      stopDataUsePolicyRefresh();
      await shutdownServer(server, {
        graceMs: SHUTDOWN_GRACE_MS,
        forceMs: SHUTDOWN_FORCE_MS,
        log: server.log,
        afterClose: async () => {
          await shutdownIntegrations();
          await cacheInvalidation.stop();
        },
      });
    })();
    return stopping;
  }

  return { server, start, stop };
}

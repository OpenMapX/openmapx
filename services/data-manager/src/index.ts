import "@openmapx/core/undici-fetch";
import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import { createFatalProcessHandler } from "@openmapx/core/server";
import Fastify from "fastify";
import { registerApi } from "./api.js";
import { registerAuth, resolveAuthToken } from "./auth.js";
import { awaitInflightSync, type CronHandles, setupCron } from "./cron.js";
import { sql } from "./db/index.js";
import { registerPoiIngestApi } from "./jobs/poi-ingest/api.js";
import { runBootstrap } from "./jobs/poi-ingest/bootstrap.js";
import { createDriftGuard, type DriftGuard } from "./jobs/poi-ingest/drift-guard.js";
import { createLogMetricsSink, type PoiIngestMetricsSink } from "./jobs/poi-ingest/metrics.js";
import {
  combineMetricsSinks,
  createOtelMetricsSink,
  getPoiMetrics,
} from "./jobs/poi-ingest/otel-metrics.js";
import { type PoiSchedulerHandles, setupPoiIngestCron } from "./jobs/poi-ingest/scheduler.js";
import { createPoiSingleFlight } from "./jobs/poi-ingest/single-flight.js";
import { reconcileOrphanedJobs } from "./jobs/reconcile.js";
import { bakePredicted } from "./jobs/traffic/bake-predicted.js";
import { fetchCoveredWayIds } from "./jobs/traffic/covered-ways.js";
import { resolveOperationsProfileFromEnv } from "./jobs/transitous/operations-profile.js";
import { getSingleFlightController } from "./jobs/transitous/runtime.js";
import { rootLogger } from "./logger.js";
import { OfflinePackageGenerator } from "./offline-packages/generator.js";
import { PostgresOfflinePackageAccountingStore } from "./offline-packages/postgres-accounting.js";
import { createOpenMapxPackageSourceFactory } from "./offline-packages/source-catalog.js";
import { OfflinePackageStorage } from "./offline-packages/storage.js";
import { discoverPoiSources } from "./poi-source-discovery.js";
import { DataManagerReadiness } from "./readiness.js";
import { createDataManagerRedisClient } from "./redis.js";
import { initializeRequiredSubsystems } from "./startup.js";
import { StateStore } from "./state.js";

const app = Fastify({ loggerInstance: rootLogger });
registerAuth(app, resolveAuthToken(app));
const readiness = new DataManagerReadiness();

const dataDir = process.env.DATA_DIR ?? "/data";
const offlinePackageStorage = new OfflinePackageStorage(join(dataDir, "offline-packages"));
const offlinePackageSource = createOpenMapxPackageSourceFactory(dataDir);
const offlinePackages = new OfflinePackageGenerator({
  source: offlinePackageSource,
  storage: offlinePackageStorage,
  accounting: new PostgresOfflinePackageAccountingStore(sql),
  logger: {
    info: (message, fields) => app.log.info(fields, message),
    warn: (message, fields) => app.log.warn(fields, message),
  },
});
const repoRoot = process.env.OPENMAPX_ROOT_DIR ?? "";
// Where to discover POI sources (`integrations/*/poi-sources.ts`) from. This
// is decoupled from `repoRoot`: repoRoot stays the host bind-mount used for
// lockfile write-backs (POST /transit/bump, gbfs-catalog-lock.ts, promote.ts's
// `docker compose -f ${repoRoot}/...`), but the image now bakes its own copy
// of `integrations/` so discovery shouldn't depend on that mount being
// present. In the built image `dist/index.js` lives at
// `/app/services/data-manager/dist` — three levels up is `/app`, the same
// depth `src/` sits at relative to the repo root in dev.
const integrationsRootDir =
  process.env.OPENMAPX_INTEGRATIONS_DIR ??
  (import.meta.dirname ? join(import.meta.dirname, "..", "..", "..") : repoRoot);
const singleFlight = getSingleFlightController();
const operationsPolicy = resolveOperationsProfileFromEnv();

// Read here rather than inside the post-listen startup block: registerApi must
// run before app.listen(), and the bake route needs to know whether
// OpenConditions is configured at registration time.
const openConditionsUrl = process.env.OPENCONDITIONS_URL?.trim() ?? "";

registerApi(app, {
  dataDir,
  offlinePackages,
  repoRoot,
  singleFlight,
  operationsPolicy,
  readiness: () => readiness.snapshot(),
  ...(openConditionsUrl && {
    bakePredicted: () =>
      bakePredicted({
        openConditionsUrl,
        // bakePredicted's logger takes (msg, extra); app.log is Pino and takes
        // (obj, msg). Same adapter shape as asCronLogger in cron.ts.
        logger: {
          info: (msg, extra) => (extra ? app.log.info(extra, msg) : app.log.info(msg)),
          warn: (msg, extra) => (extra ? app.log.warn(extra, msg) : app.log.warn(msg)),
        },
      }),
  }),
});

// E6.1c — Validate the age private-key file early so operators get a clear
// error at startup rather than a confusing "encrypted feed skipped" log
// halfway through a multi-hour GTFS run. Unset is fine: Transitous's
// fetch.py just skips encrypted entries when the env-var is absent.
const transitousFeedProxyKeyFile = process.env.TRANSITOUS_FEED_PROXY_KEY_FILE;
if (transitousFeedProxyKeyFile) {
  try {
    accessSync(transitousFeedProxyKeyFile, constants.R_OK);
  } catch (err) {
    app.log.error(
      { path: transitousFeedProxyKeyFile, err },
      "TRANSITOUS_FEED_PROXY_KEY_FILE points at an unreadable path; encrypted Transitous feeds will be skipped",
    );
  }
}

const port = Number(process.env.PORT ?? 4000);
// Bind to loopback by default. Docker-compose overrides this to 0.0.0.0 so
// app-api can reach us over the service network; exposing on 0.0.0.0 without
// the token guard would be an unauthenticated-mutation risk on multi-tenant
// hosts.
const host = process.env.HOST ?? "127.0.0.1";

// Track cron handles so the SIGTERM hook can stop them cleanly.
let cronHandles: CronHandles | null = null;
let poiHandles: PoiSchedulerHandles | null = null;

// Single authenticated Redis client for the POI ingest pipeline. Defined at module
// scope so `shutdown()` can disconnect it explicitly — otherwise SIGTERM
// hangs on the open socket. `lazyConnect: true` defers the first TCP attempt
// until the mandatory startup ping. Both connection coordinates and the
// deployment-owned password file must be explicit; production never falls
// back to an unauthenticated localhost client.
const redis = await createDataManagerRedisClient();

// POI ingest singleFlight + metricsSink + drift guard are constructed BEFORE
// `app.listen()` so the HTTP routes can be registered against them — Fastify
// disallows `app.get(...)` calls after listen. setupPoiIngestCron takes the
// same instances via opts so the cron + HTTP triggers
// share the same lock + metrics writer.
const poiAdapter = {
  info: (m: string, e?: Record<string, unknown>) => (e ? app.log.info(e, m) : app.log.info(m)),
  warn: (m: string, e?: Record<string, unknown>) => (e ? app.log.warn(e, m) : app.log.warn(m)),
  error: (m: string, e?: Record<string, unknown>) => (e ? app.log.error(e, m) : app.log.error(m)),
  debug: (m: string, e?: Record<string, unknown>) => (e ? app.log.debug(e, m) : app.log.debug(m)),
};
const poiSingleFlight = createPoiSingleFlight();
const poiMetricsSink: PoiIngestMetricsSink = combineMetricsSinks(
  createLogMetricsSink(poiAdapter),
  createOtelMetricsSink(),
);
let poiDriftGuard: DriftGuard | undefined;
const appApiBaseUrl = process.env.APP_API_BASE_URL;
if (appApiBaseUrl) {
  poiDriftGuard = createDriftGuard({
    appApiBaseUrl,
    logger: { warn: (m, e) => (e ? app.log.warn(e, m) : app.log.warn(m)) },
  });
}
registerPoiIngestApi(app, {
  sql,
  redis,
  singleFlight: poiSingleFlight,
  metricsSink: poiMetricsSink,
  driftGuard: poiDriftGuard,
});

// Prometheus scrape endpoint. Auth is bypassed (see auth.ts HEALTH_PATHS)
// because the data-manager port is bound to 127.0.0.1 on the host — only
// an in-cluster scraper can reach it. Mirrors apps/api's posture for the
// sibling `/internal/metrics` route. Registered pre-listen to satisfy
// Fastify's no-routes-after-listen invariant.
app.get("/internal/metrics", async (_request, reply) => {
  const handle = getPoiMetrics();
  const text = await handle.renderPrometheus();
  reply.header("Content-Type", "text/plain; version=0.0.4; charset=utf-8").send(text);
});

async function start(): Promise<void> {
  const store = new StateStore(dataDir);
  const countries = operationsPolicy.countries;
  const initialized = await initializeRequiredSubsystems({
    readiness,
    initializeOfflineStorage: async () => {
      await offlinePackages.initialize();
      app.log.info("offline package storage reconciled");
    },
    verifyRedis: async () => {
      await redis.ping();
    },
    reconcileJobs: reconcileOrphanedJobs,
    discoverPoiSources: async () => {
      if (!integrationsRootDir) throw new Error("no integrations root resolved");
      await discoverPoiSources({ rootDir: integrationsRootDir, logger: poiAdapter });
    },
    setupCronSchedulers: () =>
      setupCron({
        dataDir,
        repoRoot,
        countries,
        operationsPolicy,
        store,
        singleFlight,
        logger: app.log,
        openConditionsUrl,
        getCoveredWayIds: openConditionsUrl
          ? () => fetchCoveredWayIds(openConditionsUrl)
          : undefined,
      }),
    setupPoiScheduler: () =>
      setupPoiIngestCron({
        sql,
        redis,
        logger: poiAdapter,
        singleFlight: poiSingleFlight,
        metricsSink: poiMetricsSink,
      }),
  });
  cronHandles = initialized.cronHandles;
  poiHandles = initialized.poiHandles;
  if (initialized.interruptedJobIds.length > 0) {
    app.log.warn(
      {
        count: initialized.interruptedJobIds.length,
        jobIds: initialized.interruptedJobIds,
      },
      "data-manager: marked orphaned running jobs as interrupted on startup",
    );
  }

  const addr = await app.listen({ port, host });
  readiness.markReady();
  app.log.info(`data-manager listening on ${addr}`);

  // These maintenance operations already contain/log their own failures and
  // do not affect whether the registered HTTP and scheduled work is safe.
  void cronHandles.runTrafficExtractStartupNow();
  if ((process.env.OVERTURE_ENABLED || "").trim().toLowerCase() === "true") {
    void cronHandles.runOvertureConflationRetryNow();
  }

  if (process.env.POI_INGEST_BOOTSTRAP === "true") {
    app.log.info("poi-ingest-bootstrap: starting");
    void runBootstrap({
      sql,
      redis,
      singleFlight: poiSingleFlight,
      metricsSink: poiMetricsSink,
      logger: poiAdapter,
    })
      .then((result) => app.log.info(result, "poi-ingest-bootstrap: complete"))
      .catch((err) => app.log.error({ err }, "poi-ingest-bootstrap: threw"));
  }
}

void start().catch(async (err) => {
  readiness.markFailed();
  app.log.error({ err, readiness: readiness.snapshot() }, "data-manager startup failed");
  cronHandles?.stop();
  poiHandles?.stop();
  try {
    redis.disconnect();
  } catch {
    // The failed mandatory Redis probe may already have closed the client.
  }
  await app.close().catch(() => {});
  process.exit(1);
});

// Graceful shutdown — stop new cron fires, wait for any in-flight sync
// (bounded), then exit. Production-side this gives operators a clean SIGTERM
// path during `docker compose restart data-manager`; without it, a bounce
// during a multi-hour sync would truncate the catalog write.
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  // Synchronous stderr write first: pino may not flush if the process is killed
  // mid-shutdown, and we want the signal recorded no matter what.
  process.stderr.write(`data-manager: shutdown signal=${signal}\n`);
  app.log.info({ signal }, "data-manager: shutdown requested");
  cronHandles?.stop();
  poiHandles?.stop();
  try {
    redis.disconnect();
  } catch {
    // Closing an already-closed socket throws; ignore.
  }
  const result = await awaitInflightSync(singleFlight, 30_000);
  if (result === "timeout") {
    app.log.warn("data-manager: in-flight Transitous sync did not finish within 30s; forcing exit");
  }
  try {
    await app.close();
  } catch (err) {
    app.log.warn({ err }, "data-manager: fastify close threw");
  }
  process.exit(0);
}

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    void shutdown(sig);
  });
}

const onFatal = createFatalProcessHandler({
  fatal: (fields, message) => {
    process.stderr.write("data-manager: fatal uncaught error — exiting\n");
    rootLogger.fatal(fields, message);
  },
  exit: (code) => process.exit(code),
});
process.on("uncaughtException", onFatal);
process.on("unhandledRejection", onFatal);

import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import Fastify from "fastify";
import { Redis } from "ioredis";
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
import { getOpenMapxPackageSource } from "./offline-packages/source-catalog.js";
import { OfflinePackageStorage } from "./offline-packages/storage.js";
import { discoverPoiSources } from "./poi-source-discovery.js";
import { StateStore } from "./state.js";

const app = Fastify({ loggerInstance: rootLogger });
registerAuth(app, resolveAuthToken(app));

const dataDir = process.env.DATA_DIR ?? "/data";
const offlinePackageStorage = new OfflinePackageStorage(join(dataDir, "offline-packages"));
const offlinePackages = new OfflinePackageGenerator({
  source: () => getOpenMapxPackageSource(dataDir),
  storage: offlinePackageStorage,
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

// Single shared Redis client for the POI ingest pipeline. Defined at module
// scope so `shutdown()` can disconnect it explicitly — otherwise SIGTERM
// hangs on the open socket. `lazyConnect: true` defers the first TCP attempt
// until a command actually runs, so a misconfigured REDIS_URL surfaces at the
// callsite that depends on it instead of flooding the log with retries at
// boot.
const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
const redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 3 });

// POI ingest singleFlight + metricsSink + drift guard are constructed BEFORE
// `app.listen()` so the HTTP routes can be registered against them — Fastify
// disallows `app.get(...)` calls after listen. setupPoiIngestCron (after
// listen) takes the same instances via opts so the cron + HTTP triggers
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

app
  .listen({ port, host })
  .then(async (addr) => {
    app.log.info(`data-manager listening on ${addr}`);

    try {
      await offlinePackages.initialize();
      app.log.info("offline package storage reconciled");
    } catch (err) {
      app.log.error({ err }, "offline package storage initialization failed");
    }

    // Reconcile zombie jobs BEFORE wiring cron / accepting work: the
    // single-flight lock is in-memory, so on a fresh boot nothing is genuinely
    // running — any job still `running` in the DB was orphaned by a previous
    // process that died mid-run (restart / redeploy / OOM). Left alone they
    // pin the admin "Sync in progress" banner to a phantom job forever.
    try {
      const interrupted = await reconcileOrphanedJobs();
      if (interrupted.length > 0) {
        app.log.warn(
          { count: interrupted.length, jobIds: interrupted },
          "data-manager: marked orphaned running jobs as interrupted on startup",
        );
      }
    } catch (err) {
      app.log.error({ err }, "data-manager: failed to reconcile orphaned running jobs");
    }

    // Wire cron _after_ listen so an early Fastify failure doesn't leave
    // dangling cron timers and so the in-process singleFlight controller is
    // fully ready before the first scheduled fire.
    const store = new StateStore(dataDir);
    const countries = operationsPolicy.countries;
    // The way→edge refresh restricts `valhalla_ways_to_edges` to the ways the
    // live-traffic writer can update. Its covered-way-id source is the same
    // OpenConditions speed feed the writer consumes, so it's only wired when
    // OpenConditions is configured; otherwise the refresh (and the whole
    // live-traffic chain) stays disabled.
    cronHandles = setupCron({
      dataDir,
      repoRoot,
      countries,
      operationsPolicy,
      store,
      singleFlight,
      logger: app.log,
      // Pass the trimmed URL as the single source of truth so the getCoveredWayIds
      // gate here and the live/predicted crons inside setupCron can't diverge on
      // whitespace (a padded value would otherwise enable one and break the other).
      openConditionsUrl,
      getCoveredWayIds: openConditionsUrl ? () => fetchCoveredWayIds(openConditionsUrl) : undefined,
    });

    // Ensure the Valhalla traffic.tar extract exists before any job that
    // depends on it (the future live-speed writer) could try to mmap it.
    // Fire-and-forget: `runTrafficExtractStartupNow` never rejects (errors
    // are logged internally), and a slow first-time extract build shouldn't
    // block the rest of startup.
    void cronHandles.runTrafficExtractStartupNow();
    if ((process.env.OVERTURE_ENABLED || "").trim().toLowerCase() === "true") {
      // Recover an expired conflation lease immediately after a restart rather
      // than waiting for the next retry tick. The handler contains/logs errors.
      void cronHandles.runOvertureConflationRetryNow();
    }

    // Discover POI sources from each integration's poi-sources.{js,ts} file
    // BEFORE setupPoiIngestCron — the scheduler reads the registry snapshot
    // at boot, so anything that hasn't been registered yet won't get a cron.
    const customIntegrationsDir = process.env.OPENMAPX_CUSTOM_INTEGRATIONS_DIR;
    if (integrationsRootDir) {
      await discoverPoiSources({
        rootDir: integrationsRootDir,
        customIntegrationsDir,
        logger: poiAdapter,
      });
    } else {
      app.log.warn(
        "no integrations root resolved (OPENMAPX_INTEGRATIONS_DIR unset and import.meta.dirname unavailable) — skipping POI source discovery (data-manager will see an empty registry)",
      );
    }

    poiHandles = setupPoiIngestCron({
      sql,
      redis,
      logger: poiAdapter,
      singleFlight: poiSingleFlight,
      metricsSink: poiMetricsSink,
    });

    // Optional first-deploy bootstrap: kicks off an ingest for any source
    // whose feed-state row shows it has never been ingested. Runs in the
    // background so the HTTP listener stays responsive — the regular cron
    // continues firing while bootstrap is still working through the list.
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
  })
  .catch((err) => {
    app.log.error(err);
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

process.on("uncaughtException", (err) => {
  const e = err as { code?: string; stack?: string; message?: string };
  // undici (Node's global `fetch`) asserts `false == true` in
  // Parser.finish / onHttpSocketEnd when an upstream abruptly closes a socket
  // (a truncated or keep-alive-reset response). During a Transitous sync this
  // fires when the pipeline probes MOTIS while it is being recreated in the
  // promote step — a transient network fault, not a bug in our code. It is
  // emitted asynchronously on the socket, so a try/catch around the fetch can't
  // reach it; only this handler can. Swallowing it keeps the process (and the
  // in-flight sync) alive; probe/poll callers already retry on the resulting
  // fetch failure. Re-raise anything else so genuine faults still fail fast and
  // the container restart policy recovers.
  const isUndiciSocketAssert =
    e?.code === "ERR_ASSERTION" && /undici|Parser\.finish|onHttpSocketEnd/.test(e?.stack ?? "");
  if (isUndiciSocketAssert) {
    process.stderr.write(
      `data-manager: ignored transient undici socket assertion (${e?.message ?? "?"})\n`,
    );
    return;
  }
  process.stderr.write(`data-manager: fatal uncaughtException ${e?.stack ?? String(err)}\n`);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  process.stderr.write(`data-manager: unhandledRejection ${String(reason)}\n`);
});

import { accessSync, constants } from "node:fs";
import Fastify from "fastify";
import { Redis } from "ioredis";
import { registerApi } from "./api.js";
import { registerAuth, resolveAuthToken } from "./auth.js";
import { awaitInflightSync, type CronHandles, setupCron } from "./cron.js";
import { sql } from "./db/index.js";
import { registerPoiIngestApi } from "./jobs/poi-ingest/api.js";
import { runBootstrap } from "./jobs/poi-ingest/bootstrap.js";
import { createDriftGuard, type DriftGuard } from "./jobs/poi-ingest/drift-guard.js";
import { getPoiMetrics } from "./jobs/poi-ingest/otel-metrics.js";
import { type PoiSchedulerHandles, setupPoiIngestCron } from "./jobs/poi-ingest/scheduler.js";
import { getSingleFlightController } from "./jobs/transitous/runtime.js";
import { discoverPoiSources } from "./poi-source-discovery.js";
import { StateStore } from "./state.js";

const app = Fastify({ logger: true });
registerAuth(app, resolveAuthToken(app));

const dataDir = process.env.DATA_DIR ?? "/data";
const repoRoot = process.env.OPENMAPX_ROOT_DIR ?? "";
const singleFlight = getSingleFlightController();

registerApi(app, { dataDir, repoRoot, singleFlight });

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
// hangs on the open socket.
const redisUrl = process.env.REDIS_URL ?? "redis://redis:6379";
const redis = new Redis(redisUrl, { lazyConnect: false, maxRetriesPerRequest: 3 });

app
  .listen({ port, host })
  .then(async (addr) => {
    app.log.info(`data-manager listening on ${addr}`);

    // Wire cron _after_ listen so an early Fastify failure doesn't leave
    // dangling cron timers and so the in-process singleFlight controller is
    // fully ready before the first scheduled fire.
    const store = new StateStore(dataDir);
    const countries = (process.env.TRANSITOUS_COUNTRIES ?? "")
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);
    cronHandles = setupCron({
      dataDir,
      repoRoot,
      countries,
      store,
      singleFlight,
      logger: app.log,
    });

    // Discover POI sources from each integration's poi-sources.{js,ts} file
    // BEFORE setupPoiIngestCron — the scheduler reads the registry snapshot
    // at boot, so anything that hasn't been registered yet won't get a cron.
    const customIntegrationsDir = process.env.OPENMAPX_CUSTOM_INTEGRATIONS_DIR;
    if (repoRoot) {
      await discoverPoiSources({
        rootDir: repoRoot,
        customIntegrationsDir,
        logger: {
          info: (m, e) => (e ? app.log.info(e, m) : app.log.info(m)),
          warn: (m, e) => (e ? app.log.warn(e, m) : app.log.warn(m)),
          error: (m, e) => (e ? app.log.error(e, m) : app.log.error(m)),
        },
      });
    } else {
      app.log.warn(
        "OPENMAPX_ROOT_DIR not set — skipping POI source discovery (data-manager will see an empty registry)",
      );
    }

    poiHandles = setupPoiIngestCron({
      sql,
      redis,
      logger: {
        info: (m, e) => (e ? app.log.info(e, m) : app.log.info(m)),
        warn: (m, e) => (e ? app.log.warn(e, m) : app.log.warn(m)),
        error: (m, e) => (e ? app.log.error(e, m) : app.log.error(m)),
      },
    });

    // Register the POI ingest admin routes *after* the cron handles are
    // available — the HTTP routes share the cron's single-flight + metrics
    // sink so manual `/sync` triggers contend with scheduled fires correctly.
    let driftGuard: DriftGuard | undefined;
    const appApiBaseUrl = process.env.APP_API_BASE_URL;
    if (appApiBaseUrl) {
      driftGuard = createDriftGuard({
        appApiBaseUrl,
        logger: { warn: (m, e) => (e ? app.log.warn(e, m) : app.log.warn(m)) },
      });
    }
    registerPoiIngestApi(app, {
      sql,
      redis,
      singleFlight: poiHandles.singleFlight,
      metricsSink: poiHandles.metricsSink,
      driftGuard,
    });

    // Prometheus scrape endpoint. Auth is bypassed (see auth.ts HEALTH_PATHS)
    // because the data-manager port is bound to 127.0.0.1 on the host — only
    // an in-cluster scraper can reach it. Mirrors apps/api's posture for the
    // sibling `/internal/metrics` route.
    app.get("/internal/metrics", async (_request, reply) => {
      const handle = getPoiMetrics();
      const text = await handle.renderPrometheus();
      reply.header("Content-Type", "text/plain; version=0.0.4; charset=utf-8").send(text);
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
        singleFlight: poiHandles.singleFlight,
        metricsSink: poiHandles.metricsSink,
        logger: {
          info: (m, e) => (e ? app.log.info(e, m) : app.log.info(m)),
          warn: (m, e) => (e ? app.log.warn(e, m) : app.log.warn(m)),
          error: (m, e) => (e ? app.log.error(e, m) : app.log.error(m)),
          debug: (m, e) => (e ? app.log.debug(e, m) : app.log.debug(m)),
        },
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

import "@openmapx/core/undici-fetch";
import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import { createFatalProcessHandler } from "@openmapx/core/server";
import Fastify from "fastify";
import { registerApi } from "./api.js";
import { registerAuth, resolveAuthToken } from "./auth.js";
import { awaitInflightSync, type CronHandles, setupCron } from "./cron.js";
import { sql } from "./db/index.js";
import {
  type NotablePlacesSchedule,
  scheduleNotablePlaces,
} from "./jobs/notable-places/schedule.js";
import { createNotablePlacesRuntimeState } from "./jobs/notable-places/state.js";
import { reconcileOrphanedJobs } from "./jobs/reconcile.js";
import { createNotablePlacesOperationLock } from "./jobs/search-index/operation-lock.js";
import { bakePredicted } from "./jobs/traffic/bake-predicted.js";
import { fetchCoveredWayIds } from "./jobs/traffic/covered-ways.js";
import { resolveOperationsProfileFromEnv } from "./jobs/transitous/operations-profile.js";
import { getSingleFlightController } from "./jobs/transitous/runtime.js";
import { rootLogger } from "./logger.js";
import { OfflinePackageGenerator } from "./offline-packages/generator.js";
import { PostgresOfflinePackageAccountingStore } from "./offline-packages/postgres-accounting.js";
import { createOpenMapxPackageSourceFactory } from "./offline-packages/source-catalog.js";
import { OfflinePackageStorage } from "./offline-packages/storage.js";
import { DataManagerReadiness } from "./readiness.js";
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
const singleFlight = getSingleFlightController();
const operationsPolicy = resolveOperationsProfileFromEnv();

// Read here rather than inside the post-listen startup block: registerApi must
// run before app.listen(), and the bake route needs to know whether
// OpenConditions is configured at registration time.
const openConditionsUrl = process.env.OPENCONDITIONS_URL?.trim() ?? "";
// Sent as a bearer token with every OpenConditions read when set.
const openConditionsToken = process.env.OPENCONDITIONS_OPERATOR_TOKEN?.trim() ?? "";

// Shared by the build route and the scheduled refresh so the two never overlap.
const notablePlaces = {
  runtimeState: createNotablePlacesRuntimeState(),
  operationLock: createNotablePlacesOperationLock(sql),
};

registerApi(app, {
  dataDir,
  offlinePackages,
  repoRoot,
  singleFlight,
  operationsPolicy,
  notablePlaces,
  readiness: () => readiness.snapshot(),
  ...(openConditionsUrl && {
    bakePredicted: () =>
      bakePredicted({
        openConditionsUrl,
        openConditionsToken,
        // bakePredicted's logger takes (msg, extra); app.log is Pino and takes
        // (obj, msg). Same adapter shape as asCronLogger in cron.ts.
        logger: {
          info: (msg, extra) => (extra ? app.log.info(extra, msg) : app.log.info(msg)),
          warn: (msg, extra) => (extra ? app.log.warn(extra, msg) : app.log.warn(msg)),
        },
      }),
    // Routes are registered before the cron handles exist, so read them
    // lazily. Until the first successful live cycle the handles are absent
    // and the empty set is the truthful answer: nothing is baked in yet.
    getTrafficConditionsApplied: () =>
      cronHandles?.getTrafficConditionsApplied() ?? {
        schemaVersion: 1,
        mode: "shadow",
        providerId: "routing-valhalla",
        writeId: null,
        engineBootId: null,
        graphGeneration: null,
        policyRevision: null,
        validUntil: null,
        receipts: [],
        writtenAt: null,
        observationIds: [],
        resolverVersion: null,
      },
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
let notablePlacesSchedule: NotablePlacesSchedule | null = null;

async function start(): Promise<void> {
  const store = new StateStore(dataDir);
  const countries = operationsPolicy.countries;
  const initialized = await initializeRequiredSubsystems({
    readiness,
    initializeOfflineStorage: async () => {
      await offlinePackages.initialize();
      app.log.info("offline package storage reconciled");
    },
    reconcileJobs: reconcileOrphanedJobs,
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
        openConditionsToken,
        onTrafficWriterFailure: (err) => {
          app.log.error(
            { err },
            "traffic writer stopped; exiting for independent supervisor recovery",
          );
          // The thread has exited. Leave any uncertain journal/lock for the
          // supervisor, which also owns expiry while this process restarts.
          process.exit(1);
        },
        getCoveredWayIds: openConditionsUrl
          ? () => fetchCoveredWayIds(openConditionsUrl, openConditionsToken)
          : undefined,
      }),
  });
  cronHandles = initialized.cronHandles;
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
  notablePlacesSchedule = scheduleNotablePlaces({ sql, logger: app.log, ...notablePlaces });
  void notablePlacesSchedule.buildIfMissing();
  if ((process.env.OVERTURE_ENABLED || "").trim().toLowerCase() === "true") {
    void cronHandles.runOvertureConflationRetryNow();
  }
}

void start().catch(async (err) => {
  readiness.markFailed();
  app.log.error({ err, readiness: readiness.snapshot() }, "data-manager startup failed");
  cronHandles?.stop();
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
  notablePlacesSchedule?.stop();
  await offlinePackages.close();
  await cronHandles?.closeTrafficWriter();
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

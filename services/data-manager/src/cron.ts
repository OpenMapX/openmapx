import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { feedState } from "@openmapx/db-schema";
import { parseTransitSource } from "@openmapx/transitous-core";
import { Cron } from "croner";
import { and, eq } from "drizzle-orm";
import { execa } from "execa";
import type { FastifyBaseLogger } from "fastify";
import { db } from "./db/index.js";
import { applyOvertureChangelog } from "./jobs/overture/changelog.js";
import { OVERTURE_RELEASE } from "./jobs/overture/pull.js";
import {
  type EnsureTrafficExtractResult,
  ensureTrafficExtract,
  isTrafficExtractStale,
} from "./jobs/traffic/ensure-extract.js";
import {
  buildJobContext,
  type RunPipelineResult,
  runTransitousPipeline,
} from "./jobs/transitous/index.js";
import { FEED_PROXY_CONTAINER } from "./jobs/transitous/motis-containers.js";
import { finalizeJobRow, makePersistingOnStageComplete } from "./jobs/transitous/persistence.js";
import type { SingleFlightController } from "./jobs/transitous/single-flight.js";
import {
  buildGithubIssueSink,
  detectStaleFeeds,
  emitFeedAlerts,
  type GithubIssueSink,
} from "./jobs/transitous/staleness-alerts.js";
import { asJobLogger, jobChildLogger } from "./logger.js";
import type { StateStore } from "./state.js";

/**
 * Default cron expressions. The sync runs once daily at 03:00 UTC — late
 * enough that European feed publishers have rolled their nightly bundles,
 * early enough that operators see the result before their morning. The
 * feed-proxy reload heartbeat fires every 15 minutes so a freshly-written
 * `feed-proxy.conf` from a previous sync stage is picked up within a quarter
 * hour even if the sync's own `nginx -s reload` failed (network glitch,
 * container restart, etc.).
 */
const TRANSITOUS_SYNC_CRON_DEFAULT = "0 3 * * *";
const TRANSITOUS_FEED_PROXY_RELOAD_CRON_DEFAULT = "*/15 * * * *";
/**
 * Per-feed staleness alert cron. Runs daily at 04:00 UTC so it
 * fires once the 03:00 sync above has finished writing `last_fetched_at` +
 * `consecutive_failures`. Same disable sentinels apply.
 */
const TRANSITOUS_STALENESS_CHECK_CRON_DEFAULT = "0 4 * * *";
/**
 * Slow guard cron for the Valhalla traffic.tar extract. Daily at 05:00 UTC —
 * well past the 03:00 Transitous sync and any operator-triggered Overture/OSM
 * tile rebuild, so a same-day graph rebuild is caught before the next
 * request could hit a stale, edge-count-mismatched extract (see
 * `ensureTrafficExtract`'s ordering-constraint doc comment).
 */
const TRAFFIC_EXTRACT_CRON_DEFAULT = "0 5 * * *";

// Sentinel values that disable a cron entirely. Empty string is NOT one of
// them: compose injects `${VAR:-}` as "" when the operator hasn't set the var,
// and that must fall through to the built-in default (handled in
// pickCronExpression), not silently disable the schedule.
const DISABLED_SENTINELS = new Set(["disabled", "off", "false"]);

export interface CronLogger {
  info: (msg: string, extra?: Record<string, unknown>) => void;
  warn: (msg: string, extra?: Record<string, unknown>) => void;
  error: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface CronSetupOptions {
  dataDir: string;
  repoRoot: string;
  countries: string[];
  store: StateStore;
  singleFlight: SingleFlightController;
  logger: FastifyBaseLogger | CronLogger;
  /**
   * Test seam: invoked instead of the real Transitous pipeline. Production
   * callers omit this and get `runTransitousPipeline`.
   */
  runPipeline?: (jobId: string) => Promise<RunPipelineResult>;
  /**
   * Test seam: invoked instead of `execa("docker", ["exec", ...])` so the
   * unit suite never shells out to docker.
   */
  reloadFeedProxy?: () => Promise<void>;
  /** Override default schedule strings (e.g. for tests). */
  syncCronExpression?: string;
  feedProxyReloadCronExpression?: string;
  /** Override the staleness-alert schedule (e.g. for tests). */
  stalenessCheckCronExpression?: string;
  /**
   * Test seam: invoked instead of querying Postgres + (optionally) GitHub
   * from `runStalenessCheckNow`. Production callers omit this and get the
   * real `detectStaleFeeds` + GitHub sink wiring.
   */
  runStalenessCheck?: () => Promise<void>;
  /** Test seam: pre-built GitHub sink. Overrides env-var lookup. */
  githubIssueSink?: GithubIssueSink | null;
  /** Region used by the monthly Overture sync. A Geofabrik path; defaults to OPENMAPX_REGION or "europe/germany/berlin". */
  overtureRegion?: string;
  /** Override the Overture monthly cron schedule (e.g. for tests). */
  overtureCronExpression?: string;
  /**
   * Test seam: directly enable/disable the Overture cron without touching
   * OVERTURE_ENABLED. When omitted, the env var governs.
   */
  overtureEnabled?: boolean;
  /** Override the traffic-extract guard cron schedule (e.g. for tests). */
  trafficExtractCronExpression?: string;
  /**
   * Test seam: invoked instead of the real `ensureTrafficExtract` (which
   * shells out to `docker exec`/`docker restart`).
   */
  ensureTrafficExtract?: (deps: {
    logger?: { info: (msg: string, extra?: Record<string, unknown>) => void };
    force?: boolean;
  }) => Promise<EnsureTrafficExtractResult>;
  /**
   * Test seam: invoked instead of the real `isTrafficExtractStale`.
   */
  isTrafficExtractStale?: (deps: {
    logger?: { info: (msg: string, extra?: Record<string, unknown>) => void };
  }) => Promise<boolean>;
}

export interface CronHandles {
  syncCron: Cron | null;
  feedProxyReloadCron: Cron | null;
  stalenessCheckCron: Cron | null;
  overtureCron: Cron | null;
  /** Slow guard cron that rebuilds the Valhalla traffic.tar when it's stale. */
  trafficExtractCron: Cron | null;
  /** Stop all cron jobs; awaitable shutdown lives on the caller. */
  stop: () => void;
  /** Test seam: directly invoke the sync handler as if the cron fired. */
  runSyncNow: () => Promise<void>;
  /** Test seam: directly invoke the heartbeat as if the cron fired. */
  runFeedProxyReloadNow: () => Promise<void>;
  /** Test seam: directly invoke the staleness-alert handler. */
  runStalenessCheckNow: () => Promise<void>;
  /** Test seam: directly invoke the Overture monthly sync handler. */
  runOvertureNow: () => Promise<void>;
  /**
   * Run once at data-manager startup (before any job that depends on
   * traffic.tar existing, e.g. the future live-speed writer). Callers invoke
   * this explicitly right after `setupCron` returns — it is not fired by
   * `setupCron` itself so construction stays side-effect-free for tests.
   */
  runTrafficExtractStartupNow: () => Promise<void>;
  /** Test seam: directly invoke the traffic-extract guard as if the cron fired. */
  runTrafficExtractGuardNow: () => Promise<void>;
}

function pickCronExpression(
  override: string | undefined,
  envName: string,
  fallback: string,
): string | null {
  const raw = override ?? process.env[envName];
  // Unset OR empty (compose `${VAR:-}`) → built-in default. Only an explicit
  // disable sentinel turns the schedule off.
  if (raw === undefined || raw.trim() === "") return fallback;
  const trimmed = raw.trim().toLowerCase();
  if (DISABLED_SENTINELS.has(trimmed)) return null;
  return raw.trim();
}

function asCronLogger(logger: FastifyBaseLogger | CronLogger): CronLogger {
  // FastifyBaseLogger expects `(obj, msg)` ordering; CronLogger uses `(msg, obj)`.
  // Both shapes are common so we normalise to a single call site here.
  if ("info" in logger && typeof (logger as CronLogger).info === "function") {
    // Detect FastifyBaseLogger by the presence of `.child` — Pino-style.
    const maybePino = logger as FastifyBaseLogger;
    if (typeof maybePino.child === "function") {
      return {
        info: (msg, extra) => (extra ? maybePino.info(extra, msg) : maybePino.info(msg)),
        warn: (msg, extra) => (extra ? maybePino.warn(extra, msg) : maybePino.warn(msg)),
        error: (msg, extra) => (extra ? maybePino.error(extra, msg) : maybePino.error(msg)),
      };
    }
  }
  return logger as CronLogger;
}

async function writeFeedState(region: string, hash: string, log: CronLogger): Promise<void> {
  try {
    const feedRegion = `overture-places-${region}`;
    const feedName = "overture-places";
    const existing = await db
      .select({ id: feedState.id })
      .from(feedState)
      .where(and(eq(feedState.region, feedRegion), eq(feedState.name, feedName)))
      .limit(1);
    if (existing[0]) {
      await db
        .update(feedState)
        .set({ hash, lastFetchedAt: new Date(), status: "active" })
        .where(eq(feedState.id, existing[0].id));
    } else {
      await db.insert(feedState).values({
        region: feedRegion,
        name: feedName,
        hash,
        lastFetchedAt: new Date(),
        status: "active",
      });
    }
  } catch (err) {
    log.warn("overture-cron: feed_state write failed", { err: (err as Error).message });
  }
}

/**
 * Wire up the daily Transitous sync + feed-proxy reload heartbeat. Both jobs
 * are owned by the data-manager process so that they share its inflight lock
 * (one sync at a time, no matter the trigger).
 */
export function setupCron(options: CronSetupOptions): CronHandles {
  const log = asCronLogger(options.logger);
  const syncExpr = pickCronExpression(
    options.syncCronExpression,
    "TRANSITOUS_SYNC_CRON",
    TRANSITOUS_SYNC_CRON_DEFAULT,
  );
  const feedProxyReloadExpr = pickCronExpression(
    options.feedProxyReloadCronExpression,
    "TRANSITOUS_FEED_PROXY_RELOAD_CRON",
    TRANSITOUS_FEED_PROXY_RELOAD_CRON_DEFAULT,
  );
  const stalenessCheckExpr = pickCronExpression(
    options.stalenessCheckCronExpression,
    "TRANSITOUS_STALENESS_CHECK_CRON",
    TRANSITOUS_STALENESS_CHECK_CRON_DEFAULT,
  );

  // Resolve the GitHub issue sink once. The env-var path is opt-in: without
  // both `TRANSITOUS_ALERT_GH_TOKEN` and `TRANSITOUS_ALERT_GH_REPO` the
  // staleness check only emits log lines.
  const githubIssue: GithubIssueSink | null =
    options.githubIssueSink !== undefined
      ? options.githubIssueSink
      : buildGithubIssueSink(
          process.env.TRANSITOUS_ALERT_GH_TOKEN?.trim() || undefined,
          process.env.TRANSITOUS_ALERT_GH_REPO?.trim() || undefined,
        );

  let lastFeedProxyReloadAt: number | null = null;
  const feedProxyConfPath = join(options.dataDir, "motis-feed-proxy", "conf", "feed-proxy.conf");

  const runSync = async (): Promise<void> => {
    const start = await options.singleFlight.tryStartSync({
      trigger: "cron",
      triggeredBy: "data-manager-cron",
      kind: "transitous-sync",
      metadata: { source: "cron" },
    });
    if (!start.ok) {
      // Don't escalate: cron firing while a manual sync is in-flight is fine.
      log.warn("transitous-cron: skipped scheduled run", { reason: start.reason });
      return;
    }
    log.info("transitous-cron: starting scheduled sync", { jobId: start.jobId });
    let finalStatus: RunPipelineResult["finalStatus"] = "error";
    try {
      let result: RunPipelineResult;
      if (options.runPipeline) {
        result = await options.runPipeline(start.jobId);
      } else {
        const jobLog = asJobLogger(
          jobChildLogger({ job: "transitous-sync", jobId: start.jobId, trigger: "cron" }),
        );
        const ctx = buildJobContext({
          dataDir: options.dataDir,
          store: options.store,
          countries: options.countries,
          repoRoot: options.repoRoot,
          source: parseTransitSource(),
          jobId: start.jobId,
          logger: jobLog,
          onStageComplete: makePersistingOnStageComplete(start.jobId, jobLog),
        });
        result = await runTransitousPipeline(ctx);
      }
      finalStatus = result.finalStatus;
      log.info("transitous-cron: sync completed", {
        jobId: start.jobId,
        finalStatus,
        stageCount: result.results.length,
      });
    } catch (err) {
      log.error("transitous-cron: sync threw", {
        jobId: start.jobId,
        err: (err as Error).message,
      });
      finalStatus = "error";
    } finally {
      try {
        await finalizeJobRow(start.jobId, finalStatus);
      } catch (err) {
        log.warn("transitous-cron: finalizeJobRow failed", {
          jobId: start.jobId,
          err: (err as Error).message,
        });
      }
      options.singleFlight.markSyncFinished();
    }

    // Run the staleness check immediately after every sync so an
    // out-of-band failure that would otherwise wait for the daily 04:00 cron
    // surfaces at the same wallclock minute as the sync that caused it.
    try {
      await runStalenessCheck();
    } catch (err) {
      log.warn("transitous-cron: post-sync staleness check failed", {
        err: (err as Error).message,
      });
    }
  };

  const defaultStalenessCheck = async (): Promise<void> => {
    const alerts = await detectStaleFeeds();
    if (alerts.length === 0) {
      log.info("transitous-cron: staleness check found no alerts");
      return;
    }
    await emitFeedAlerts({
      alerts,
      log,
      githubIssue: githubIssue ?? undefined,
    });
  };

  const runStalenessCheck = options.runStalenessCheck ?? defaultStalenessCheck;

  const defaultReload = async (): Promise<void> => {
    await execa("docker", ["exec", FEED_PROXY_CONTAINER, "nginx", "-s", "reload"], {
      stdio: "pipe",
    });
  };

  const runFeedProxyReload = async (): Promise<void> => {
    if (!existsSync(feedProxyConfPath)) {
      // Feed-proxy isn't deployed yet (fresh stack) — nothing to do.
      return;
    }
    let mtimeMs: number;
    try {
      mtimeMs = statSync(feedProxyConfPath).mtimeMs;
    } catch (err) {
      log.warn("transitous-cron: feed-proxy.conf stat failed", {
        err: (err as Error).message,
      });
      return;
    }
    if (lastFeedProxyReloadAt !== null && mtimeMs <= lastFeedProxyReloadAt) {
      // No change since last reload — heartbeat is a no-op.
      return;
    }
    try {
      const reload = options.reloadFeedProxy ?? defaultReload;
      await reload();
      lastFeedProxyReloadAt = mtimeMs;
      log.info("transitous-cron: feed-proxy reloaded", { mtimeMs });
    } catch (err) {
      log.warn("transitous-cron: feed-proxy reload failed", {
        err: (err as Error).message,
      });
    }
  };

  const syncCron = syncExpr
    ? new Cron(syncExpr, { name: "transitous-sync", protect: true }, () => {
        // Swallow rejections so an unhandled cron exception doesn't crash
        // the process; `runSync` already logs internally.
        void runSync().catch((err) => {
          log.error("transitous-cron: unexpected runSync rejection", {
            err: (err as Error).message,
          });
        });
      })
    : null;

  const feedProxyReloadCron = feedProxyReloadExpr
    ? new Cron(feedProxyReloadExpr, { name: "transitous-feed-proxy-reload", protect: true }, () => {
        void runFeedProxyReload().catch((err) => {
          log.warn("transitous-cron: feed-proxy heartbeat threw", {
            err: (err as Error).message,
          });
        });
      })
    : null;

  const stalenessCheckCron = stalenessCheckExpr
    ? new Cron(stalenessCheckExpr, { name: "transitous-staleness-check", protect: true }, () => {
        void runStalenessCheck().catch((err) => {
          log.warn("transitous-cron: staleness check threw", {
            err: (err as Error).message,
          });
        });
      })
    : null;

  const overtureEnabled =
    options.overtureEnabled ?? (process.env.OVERTURE_ENABLED || "").trim().toLowerCase() === "true";

  const overtureExpr = overtureEnabled
    ? pickCronExpression(options.overtureCronExpression, "OVERTURE_SYNC_CRON", "0 5 1 * *")
    : null;

  const runOvertureSync = async (): Promise<void> => {
    const region =
      options.overtureRegion ?? (process.env.OPENMAPX_REGION || "europe/germany/berlin");
    const release = OVERTURE_RELEASE;
    try {
      await applyOvertureChangelog({
        region,
        release,
        dataDir: options.dataDir,
        onProgress: (msg) => log.info(msg),
      });
      await writeFeedState(region, release, log);
      await runStalenessCheck();
    } catch (err) {
      log.error("overture-cron: sync failed", { err: (err as Error).message });
    }
  };

  let overtureCron: Cron | null = null;
  if (!overtureEnabled) {
    log.info("overture-cron: disabled (OVERTURE_ENABLED not set or false)");
  } else if (!overtureExpr) {
    log.info("overture-cron: disabled by cron expression sentinel");
  } else {
    overtureCron = new Cron(overtureExpr, { name: "overture-monthly-sync", protect: true }, () => {
      void runOvertureSync().catch((err) => {
        log.error("overture-cron: unexpected rejection", { err: (err as Error).message });
      });
    });
    log.info("overture-cron: scheduled", { expression: overtureExpr });
  }

  const ensureExtract = options.ensureTrafficExtract ?? ensureTrafficExtract;
  const checkExtractStale = options.isTrafficExtractStale ?? isTrafficExtractStale;

  const runTrafficExtractStartup = async (): Promise<void> => {
    try {
      const result = await ensureExtract({ logger: log });
      log.info("traffic-extract: startup check complete", { built: result.built });
    } catch (err) {
      log.error("traffic-extract: startup ensure failed", { err: (err as Error).message });
    }
  };

  const runTrafficExtractGuard = async (): Promise<void> => {
    try {
      const stale = await checkExtractStale({ logger: log });
      if (!stale) {
        log.info("traffic-extract: guard check found no rebuild needed");
        return;
      }
      // A stale extract doesn't fail soft — Valhalla throws mid-request when
      // the traffic tile's directed_edge_count disagrees with the graph
      // tile, so rebuild eagerly rather than wait for a request to surface
      // it. `force` skips the redundant presence check: we already know the
      // file exists, just that it's outdated.
      log.info("traffic-extract: graph tiles newer than traffic.tar, rebuilding");
      const result = await ensureExtract({ logger: log, force: true });
      log.info("traffic-extract: guard rebuild complete", { built: result.built });
    } catch (err) {
      log.error("traffic-extract: guard check failed", { err: (err as Error).message });
    }
  };

  const trafficExtractExpr = pickCronExpression(
    options.trafficExtractCronExpression,
    "TRAFFIC_EXTRACT_CRON",
    TRAFFIC_EXTRACT_CRON_DEFAULT,
  );

  const trafficExtractCron = trafficExtractExpr
    ? new Cron(
        trafficExtractExpr,
        { name: "valhalla-traffic-extract-guard", protect: true },
        () => {
          void runTrafficExtractGuard().catch((err) => {
            log.error("traffic-extract: guard cron threw", { err: (err as Error).message });
          });
        },
      )
    : null;

  if (!trafficExtractCron) log.info("traffic-extract: guard cron disabled by env");
  else log.info("traffic-extract: guard cron scheduled", { expression: trafficExtractExpr });

  if (!syncCron) log.info("transitous-cron: sync disabled by env");
  else log.info("transitous-cron: sync scheduled", { expression: syncExpr });
  if (!feedProxyReloadCron) log.info("transitous-cron: feed-proxy reload disabled by env");
  else
    log.info("transitous-cron: feed-proxy reload scheduled", {
      expression: feedProxyReloadExpr,
    });
  if (!stalenessCheckCron) log.info("transitous-cron: staleness check disabled by env");
  else
    log.info("transitous-cron: staleness check scheduled", {
      expression: stalenessCheckExpr,
      githubIssueSink: githubIssue !== null,
    });

  function stop(): void {
    syncCron?.stop();
    feedProxyReloadCron?.stop();
    stalenessCheckCron?.stop();
    overtureCron?.stop();
    trafficExtractCron?.stop();
  }

  return {
    syncCron,
    feedProxyReloadCron,
    stalenessCheckCron,
    overtureCron,
    trafficExtractCron,
    stop,
    runSyncNow: runSync,
    runFeedProxyReloadNow: runFeedProxyReload,
    runStalenessCheckNow: runStalenessCheck,
    runOvertureNow: runOvertureSync,
    runTrafficExtractStartupNow: runTrafficExtractStartup,
    runTrafficExtractGuardNow: runTrafficExtractGuard,
    // `activeJobId` is exposed indirectly through singleFlight.getInflight()
    // for the shutdown helper — no need to surface it here.
  };
}

/**
 * Wait until any in-flight sync finishes, or `timeoutMs` elapses. Used during
 * graceful shutdown so SIGTERM doesn't truncate a half-promoted catalog.
 */
export async function awaitInflightSync(
  singleFlight: SingleFlightController,
  timeoutMs: number,
  pollMs = 250,
): Promise<"finished" | "timeout"> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!singleFlight.getInflight()) return "finished";
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return singleFlight.getInflight() ? "timeout" : "finished";
}

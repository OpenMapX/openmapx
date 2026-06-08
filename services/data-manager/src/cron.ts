import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { Cron } from "croner";
import { execa } from "execa";
import type { FastifyBaseLogger } from "fastify";
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

/** Sentinel values that disable a cron entirely. Mirrors the K8s convention. */
const DISABLED_SENTINELS = new Set(["", "disabled", "off", "false"]);

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
}

export interface CronHandles {
  syncCron: Cron | null;
  feedProxyReloadCron: Cron | null;
  stalenessCheckCron: Cron | null;
  /** Stop all cron jobs; awaitable shutdown lives on the caller. */
  stop: () => void;
  /** Test seam: directly invoke the sync handler as if the cron fired. */
  runSyncNow: () => Promise<void>;
  /** Test seam: directly invoke the heartbeat as if the cron fired. */
  runFeedProxyReloadNow: () => Promise<void>;
  /** Test seam: directly invoke the staleness-alert handler. */
  runStalenessCheckNow: () => Promise<void>;
}

function pickCronExpression(
  override: string | undefined,
  envName: string,
  fallback: string,
): string | null {
  const raw = override ?? process.env[envName];
  if (raw === undefined) return fallback;
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
        const ctx = buildJobContext({
          dataDir: options.dataDir,
          store: options.store,
          countries: options.countries,
          repoRoot: options.repoRoot,
          jobId: start.jobId,
          onStageComplete: makePersistingOnStageComplete(start.jobId, {
            info: (m) => log.info(m),
            warn: (m) => log.warn(m),
            error: (m) => log.error(m),
          }),
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
  }

  return {
    syncCron,
    feedProxyReloadCron,
    stalenessCheckCron,
    stop,
    runSyncNow: runSync,
    runFeedProxyReloadNow: runFeedProxyReload,
    runStalenessCheckNow: runStalenessCheck,
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

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as durableDelay } from "node:timers/promises";
import {
  type DataExecutionStatus,
  DEFAULT_CATALOG_BRANCH,
  isDataExecutionTerminal,
} from "@openmapx/core/data-manager-contracts";

import { OVERTURE_PLACES_SCHEMA_VERSION } from "@openmapx/core/published-data";
import { envString } from "@openmapx/core/server-env";
import {
  FEED_PROXY_CONFIG_FILENAME,
  FEED_PROXY_CONFIG_SUBDIR,
} from "@openmapx/motis-feed-proxy-config";
import { Cron } from "croner";
import type { FastifyBaseLogger } from "fastify";
import { z } from "zod/v4";
import { db } from "./db/index.js";
import type { DataExecutionReceiver } from "./jobs/execution/api.js";
import { runLocalDataExecution } from "./jobs/execution/local.js";
import { createGithubIssueSink, type GithubIssueSink } from "./jobs/github-issue-sink.js";
import { discoverLatestOvertureRelease } from "./jobs/overture/pull.js";
import { compareOvertureReleases } from "./jobs/overture/retention.js";
import {
  type BakePredictedDeps,
  type BakePredictedResult,
  bakePredicted as bakePredictedDefault,
} from "./jobs/traffic/bake-predicted.js";
import {
  type EnsureTrafficExtractResult,
  ensureTrafficExtract,
  isTrafficExtractStale,
} from "./jobs/traffic/ensure-extract.js";
import { openConditionsHeaders } from "./jobs/traffic/openconditions-auth.js";
import {
  type RefreshWaysToEdgesResult,
  refreshWaysToEdges as refreshWaysToEdgesDefault,
  defaultOutputPath as waysToEdgesMapPath,
} from "./jobs/traffic/ways-to-edges.js";
import type { CatalogBumpCandidate } from "./jobs/transitous/catalog-bump.js";
import type { MotisOperationsPolicy } from "./jobs/transitous/operations-profile.js";
import type { SingleFlightController } from "./jobs/transitous/single-flight.js";
import {
  detectStaleFeeds,
  emitFeedAlerts,
  emitPipelineFailureAlert,
} from "./jobs/transitous/staleness-alerts.js";
import type { StateStore } from "./state.js";
import {
  createTrafficLiveService,
  type TrafficLiveOptions,
  type TrafficLiveService,
} from "./traffic-live-service.js";
import { pickCronExpression, pickOptInCronExpression } from "./utils/cron-expression.js";

/**
 * Default cron expressions. The sync runs once daily at 03:00 UTC — late
 * enough that European feed publishers have rolled their nightly bundles,
 * early enough that operators see the result before their morning. The
 * feed-proxy reload heartbeat fires every 15 minutes so a freshly-written
 * `conf/default.conf` from a previous sync stage is picked up within a quarter
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
/**
 * Live-speed writer cron: fetches the OpenConditions speed feed and pokes
 * the current values straight into `traffic.tar`'s mmapped records. Every 2
 * minutes — frequent enough that live speeds feel current. A tick that finds
 * the previous cycle still running is skipped.
 */
const TRAFFIC_LIVE_CRON_DEFAULT = "*/2 * * * *";
/**
 * Predicted-traffic bake cron: fetches OpenConditions' historical speed
 * profiles and bakes them into Valhalla's loose graph tiles, then rebuilds
 * the traffic.tar extract + way-to-edge map and restarts Valhalla. Weekly,
 * Monday 06:00 UTC — after the OpenConditions profile-derive job (Monday
 * 03:30) has had time to publish a fresh `segments/profiles.json`, and well
 * past the 05:00 daily extract-guard cron so the two rebuild chains don't
 * race the same `traffic.tar`/way-to-edge map. Unlike the every-2-minute live
 * writer, this bake shells out to a slow tile-rewriting tool and restarts
 * Valhalla, so it runs far less often.
 */
const TRAFFIC_PREDICTED_CRON_DEFAULT = "0 6 * * 1";

export interface CronLogger {
  info: (msg: string, extra?: Record<string, unknown>) => void;
  warn: (msg: string, extra?: Record<string, unknown>) => void;
  error: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface CronSetupOptions extends TrafficLiveOptions {
  catalogReview?: Pick<
    ReturnType<typeof import("./jobs/transitous/catalog-review.js").createCatalogReviewService>,
    "resolveCatalogProposal"
  >;
  executionReceiver?: DataExecutionReceiver;
  dataDir: string;
  countries: string[];
  operationsPolicy?: MotisOperationsPolicy;
  store: StateStore;
  singleFlight: SingleFlightController;
  logger: FastifyBaseLogger | CronLogger;
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
  /** Region used by the Overture release sync. A Geofabrik path; defaults to OPENMAPX_REGION or "europe/germany/berlin". */
  overtureRegion?: string;
  /** Override the Overture release-check schedule (e.g. for tests). */
  overtureCronExpression?: string;
  /** Retry schedule for the independently durable OSM↔Overture link rebuild. */
  overtureConflationRetryCronExpression?: string;
  /**
   * Test seam: directly enable/disable the Overture cron without touching
   * OVERTURE_ENABLED. When omitted, the env var governs.
   */
  overtureEnabled?: boolean;
  /** Test seam: resolve the latest published Overture release. */
  discoverOvertureRelease?: () => Promise<string>;
  /** Test seam: read the release currently installed in Postgres. */
  getInstalledOvertureRelease?: () => Promise<string | null>;
  /** Test seam: whether another builder version wrote the installed places. */
  hasOutdatedOverturePlaces?: () => Promise<boolean>;
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
  /**
   * Resolves the set of OSM way ids the live-speed writer currently covers.
   * The entrypoint wires this to `fetchCoveredWayIds` (the same OpenConditions
   * speed feed the writer consumes) when OpenConditions is configured; when
   * absent, the startup/guard way-to-edge refresh logs and skips rather than
   * writing a map filtered down to nothing — the whole live-traffic chain then
   * stays disabled.
   */
  getCoveredWayIds?: () => Promise<Set<number>>;
  /**
   * Test seam: invoked instead of the real `refreshWaysToEdges` (which
   * shells out to `docker exec`).
   */
  refreshWaysToEdges?: (
    coveredWayIds: Set<number>,
    deps?: { logger?: { info: (msg: string, extra?: Record<string, unknown>) => void } },
  ) => Promise<RefreshWaysToEdgesResult>;
  /** Override the live-traffic writer cron schedule (e.g. for tests). */
  trafficLiveCronExpression?: string;
  /**
   * Base URL of the OpenConditions ingest extension's speed feed (`GET
   * {url}/segments/speed.csv`). Defaults to `OPENCONDITIONS_URL`; when
   * neither is configured the live-traffic cron isn't scheduled at all —
   * OpenConditions is an optional community extension, not every deployment
   * has it installed.
   */
  openConditionsUrl?: string;
  /**
   * Operator token sent as `Authorization: Bearer` with every OpenConditions
   * read, so restricted sources reach the traffic graph too. Defaults to
   * `OPENCONDITIONS_OPERATOR_TOKEN`; unset reads in public scope.
   */
  openConditionsToken?: string;
  /** Override the predicted-traffic bake cron schedule (e.g. for tests). */
  trafficPredictedCronExpression?: string;
  /**
   * Test seam: invoked instead of the real `bakePredicted` (which shells out
   * to `docker exec`/`docker restart` and writes CSVs to disk). Gated on
   * `openConditionsUrl` exactly like the live-traffic writer above.
   */
  bakePredicted?: (deps: BakePredictedDeps) => Promise<BakePredictedResult>;
  /**
   * Override the auto-bump schedule. Auto-bump is OPT-IN: unlike the daily
   * sync, an unset/empty value leaves it disabled — operators enable it
   * explicitly with `TRANSITOUS_AUTO_BUMP_CRON`.
   */
  autoBumpCronExpression?: string;
  /** Test seam: resolve the upstream catalog candidate. */
  resolveBumpCandidate?: (opts: {
    catalogDir: string;
    branch: string;
  }) => Promise<CatalogBumpCandidate>;
}

/** The scheduled jobs, each `null` when its schedule is disabled. */
interface CronJobs {
  syncCron: Cron | null;
  feedProxyReloadCron: Cron | null;
  stalenessCheckCron: Cron | null;
  overtureCron: Cron | null;
  overtureConflationRetryCron: Cron | null;
  /** Slow guard cron that rebuilds the Valhalla traffic.tar when it's stale. */
  trafficExtractCron: Cron | null;
  /** Live-traffic writer cron; null when OpenConditions isn't configured. */
  trafficLiveCron: Cron | null;
  /** Predicted-traffic bake cron; null when OpenConditions isn't configured. */
  trafficPredictedCron: Cron | null;
  /** Weekly auto-bump cron; null unless `TRANSITOUS_AUTO_BUMP_CRON` is set (opt-in). */
  autoBumpCron: Cron | null;
}

export interface CronHandles extends CronJobs {
  /** Stop all cron jobs; awaitable shutdown lives on the caller. */
  stop: () => void;
  /** The live-speed writer: run a cycle, read what it applied, close its writer. */
  trafficLive: TrafficLiveService;
  /** Test seam: directly invoke the sync handler as if the cron fired. */
  runSyncNow: () => Promise<void>;
  /** Test seam: directly invoke the heartbeat as if the cron fired. */
  runFeedProxyReloadNow: () => Promise<void>;
  /** Test seam: directly invoke the staleness-alert handler. */
  runStalenessCheckNow: () => Promise<void>;
  /** Test seam: directly invoke the Overture release sync handler. */
  runOvertureNow: () => Promise<void>;
  /** Test seam: retry link rebuilding without release discovery or Places ingest. */
  runOvertureConflationRetryNow: () => Promise<void>;
  /**
   * Run once at startup: re-imports places an older builder wrote, otherwise
   * retries link rebuilding.
   */
  runOvertureStartupNow: () => Promise<void>;
  /**
   * Run once at data-manager startup (before any job that depends on
   * traffic.tar existing, e.g. the live-speed writer cron below). Callers
   * invoke this explicitly right after `setupCron` returns — it is not fired
   * by `setupCron` itself so construction stays side-effect-free for tests.
   */
  runTrafficExtractStartupNow: () => Promise<void>;
  /** Test seam: directly invoke the traffic-extract guard as if the cron fired. */
  runTrafficExtractGuardNow: () => Promise<void>;
  /** Test seam: directly invoke the way_id-to-GraphId map refresh. */
  runWaysToEdgesRefreshNow: () => Promise<void>;
  /** Test seam: directly invoke the predicted-traffic bake as if the cron fired. */
  runTrafficPredictedNow: () => Promise<void>;
  /** Test seam: directly invoke the auto-bump handler as if the cron fired. */
  runAutoBumpNow: () => Promise<void>;
}

/** One row of the schedule table. */
interface ScheduledJob {
  /** Croner job name. */
  name: string;
  /** The resolved schedule; null leaves the job unscheduled. */
  expression: string | null;
  run: () => Promise<void>;
  /** Logged when a run rejects. Runs log their own failures; this is the last resort. */
  onReject: { level: "error" | "warn"; message: string };
  /** Logged once when the job is scheduled, with its expression. */
  scheduled: string;
  scheduledDetails?: Record<string, unknown>;
  /** Logged once when the job is not scheduled. */
  disabled: string;
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

/** Schedule one table row and log whether it runs. */
function startJob(job: ScheduledJob, log: CronLogger): Cron | null {
  if (!job.expression) {
    log.info(job.disabled);
    return null;
  }
  const cron = new Cron(job.expression, { name: job.name, protect: true }, () =>
    // Return the full job lifetime so Croner keeps overlap protection.
    job.run().catch((err) => {
      log[job.onReject.level](job.onReject.message, { err: (err as Error).message });
    }),
  );
  log.info(job.scheduled, { expression: job.expression, ...job.scheduledDetails });
  return cron;
}

/** The installed Overture release; none when an older builder wrote the places. */
export async function getInstalledOvertureRelease(): Promise<string | null> {
  try {
    const rows = await db.execute<{ release: string }>(
      `SELECT places.release
       FROM overture_places.places
       JOIN overture_places.conflation_state AS state
         ON state.singleton = 1 AND state.schema_version = ${OVERTURE_PLACES_SCHEMA_VERSION}
       ORDER BY places.imported_at DESC
       LIMIT 1`,
    );
    return rows[0]?.release ?? null;
  } catch {
    return null;
  }
}

/** Whether published Overture places were written by another builder version. */
export async function hasOutdatedOverturePlaces(): Promise<boolean> {
  try {
    const rows = await db.execute<{ outdated: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM overture_places.conflation_state
          WHERE singleton = 1 AND schema_version <> ${OVERTURE_PLACES_SCHEMA_VERSION}
       ) AS outdated`,
    );
    return rows[0]?.outdated === true;
  } catch {
    return false;
  }
}

const transitFailureSchema = z.object({
  results: z.array(
    z.object({
      stage: z.string(),
      status: z.string(),
      error: z.object({ message: z.string() }).optional(),
    }),
  ),
});

/**
 * Wire up the data-manager's scheduled jobs: the Transitous sync, feed-proxy
 * heartbeat, staleness alerts and auto-bump, the Overture sync and link retry,
 * and the traffic extract guard, live writer and predicted bake. They are owned
 * by the data-manager process so that they share its inflight lock (one sync at
 * a time, no matter the trigger).
 */
export function setupCron(options: CronSetupOptions): CronHandles {
  const log = asCronLogger(options.logger);

  // Resolve the GitHub issue sink once. The env-var path is opt-in: without
  // both `TRANSITOUS_ALERT_GH_TOKEN` and `TRANSITOUS_ALERT_GH_REPO` the
  // staleness check only emits log lines.
  const githubIssue: GithubIssueSink | null =
    options.githubIssueSink !== undefined
      ? options.githubIssueSink
      : createGithubIssueSink({
          token: process.env.TRANSITOUS_ALERT_GH_TOKEN,
          repository: process.env.TRANSITOUS_ALERT_GH_REPO,
        });

  let lastFeedProxyReloadAt: number | null = null;
  const feedProxyConfPath = join(
    options.dataDir,
    "motis-feed-proxy",
    FEED_PROXY_CONFIG_SUBDIR,
    FEED_PROXY_CONFIG_FILENAME,
  );

  const receiver = () => {
    if (!options.executionReceiver) throw Error("Durable data execution receiver is unavailable");
    return options.executionReceiver;
  };
  const observeOwned = async (status: DataExecutionStatus) => {
    let current = status;
    while (!isDataExecutionTerminal(current) || current.publication === "unknown") {
      const remaining = status.deadlineAt - Date.now();
      if (remaining <= 0)
        throw Error(`Data execution ${status.id} observation pending at its original deadline`);
      await durableDelay(Math.min(250, remaining));
      const found = await receiver().inspect(status.id);
      if (
        !found ||
        found.operationKey !== status.operationKey ||
        found.fingerprint !== status.fingerprint ||
        found.admittedAt !== status.admittedAt ||
        found.deadlineAt !== status.deadlineAt
      )
        throw Error(`Data execution ${status.id} requires retained reconciliation`);
      current = found;
    }
    return current;
  };
  const requireSuccessful = async (status: DataExecutionStatus) => {
    const result = await observeOwned(status);
    if (result.status !== "succeeded" && result.status !== "partially_succeeded")
      throw Error(`Data execution ${result.id} ${result.status}`);
    return result;
  };
  const runSync = async (): Promise<void> => {
    try {
      const admitted = await receiver().admitLocal(
        { kind: "transit-sync", countries: options.countries },
        { trigger: "cron" },
      );
      log.info("transitous-cron: queued durable sync", { jobId: admitted.id });
      const result = await observeOwned(admitted);
      log.info("transitous-cron: sync settled", { jobId: result.id, status: result.status });
      if (result.status !== "succeeded") {
        const trusted = receiver().legacyResult(result.id),
          failure = transitFailureSchema.safeParse(trusted),
          failed = failure.success
            ? failure.data.results.find((stage) => stage.status === "failed")
            : undefined;
        await emitPipelineFailureAlert({
          alert: {
            trigger: "cron",
            jobId: result.id,
            failedStage: failed?.stage,
            reason:
              failed?.error?.message ??
              result.diagnostics.tail.at(-1)?.message ??
              `Transit execution ${result.status}`,
          },
          log,
          githubIssue: githubIssue ?? undefined,
        });
      }
    } catch (err) {
      log.error("transitous-cron: sync remains failed or pending", { err: (err as Error).message });
    }
    await runStalenessCheck();
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

  /** Scheduled checks create paired proposals only. Activation always requires review. */
  const runAutoBump = async (): Promise<void> => {
    if (!options.catalogReview) throw Error("Installed paired catalog resolver is unavailable");
    const proposal = await options.catalogReview.resolveCatalogProposal({
      branch: envString("TRANSITOUS_AUTO_BUMP_BRANCH", DEFAULT_CATALOG_BRANCH),
      actor: { trigger: "cron" },
    });
    log.info("transitous-auto-bump: paired proposal retained for administrator review", {
      proposalId: proposal.proposalId,
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
      log.warn(`transitous-cron: ${FEED_PROXY_CONFIG_FILENAME} stat failed`, {
        err: (err as Error).message,
      });
      return;
    }
    if (lastFeedProxyReloadAt !== null && mtimeMs <= lastFeedProxyReloadAt) {
      // No change since last reload — heartbeat is a no-op.
      return;
    }
    try {
      await requireSuccessful(
        await receiver().admitMaintenance("reload-feed-proxy", { trigger: "cron" }),
      );
      lastFeedProxyReloadAt = mtimeMs;
      log.info("transitous-cron: feed-proxy reloaded", { mtimeMs });
    } catch (err) {
      log.warn("transitous-cron: feed-proxy reload failed", {
        err: (err as Error).message,
      });
    }
  };

  const overtureEnabled =
    options.overtureEnabled ?? (process.env.OVERTURE_ENABLED || "").trim().toLowerCase() === "true";

  const runOvertureConflationRetry = async (): Promise<void> => {
    const region = options.overtureRegion ?? process.env.OPENMAPX_REGION ?? "europe/germany/berlin";
    try {
      if (!(await (options.getInstalledOvertureRelease ?? getInstalledOvertureRelease)())) return;
      await requireSuccessful(
        await receiver().admitLocal({ kind: "overture-conflate", region }, { trigger: "cron" }),
      );
    } catch (err) {
      log.error("overture-conflation: durable retry failed or remains pending", {
        err: (err as Error).message,
      });
    }
  };

  const runOvertureSync = async (): Promise<void> => {
    const region = options.overtureRegion ?? process.env.OPENMAPX_REGION ?? "europe/germany/berlin";
    try {
      const latest = await (options.discoverOvertureRelease ?? discoverLatestOvertureRelease)(),
        installed = await (options.getInstalledOvertureRelease ?? getInstalledOvertureRelease)();
      if (installed && compareOvertureReleases(latest, installed) <= 0) {
        await runOvertureConflationRetry();
        return;
      }
      const result = await requireSuccessful(
        await receiver().admitLocal({ kind: "overture-sync", region }, { trigger: "cron" }),
      );
      if (result.status === "partially_succeeded")
        log.warn("overture-cron: Places imported; link rebuild remains incomplete", {
          jobId: result.id,
          diagnostics: result.diagnostics,
        });
      await runStalenessCheck();
    } catch (err) {
      log.error("overture-cron: durable sync failed or remains pending", {
        err: (err as Error).message,
      });
    }
  };

  const runOvertureStartup = async (): Promise<void> => {
    if (await (options.hasOutdatedOverturePlaces ?? hasOutdatedOverturePlaces)()) {
      log.info("overture: installed places use an outdated layout; re-importing");
      await runOvertureSync();
      return;
    }
    await runOvertureConflationRetry();
  };

  const openConditionsUrl = options.openConditionsUrl ?? envString("OPENCONDITIONS_URL", "");
  const openConditionsToken =
    options.openConditionsToken ?? envString("OPENCONDITIONS_OPERATOR_TOKEN", "");

  const ensureExtract = options.ensureTrafficExtract ?? ensureTrafficExtract;
  const checkExtractStale = options.isTrafficExtractStale ?? isTrafficExtractStale;

  const refreshWaysToEdges = options.refreshWaysToEdges ?? refreshWaysToEdgesDefault;

  // The way_id → GraphId map is refreshed from the current OpenConditions key
  // set so both traffic writers see ways added since the last graph rebuild.
  // It runs inside a traffic-maintenance execution.
  const refreshWaysToEdgesMap = async (): Promise<void> => {
    if (!options.getCoveredWayIds) {
      log.info("ways-to-edges: refresh skipped (no covered-way-id source configured)");
      return;
    }
    try {
      const coveredWayIds = await options.getCoveredWayIds();
      const result = await refreshWaysToEdges(coveredWayIds, { logger: log });
      log.info("ways-to-edges: refresh complete", {
        wayCount: result.wayCount,
        edgeCount: result.edgeCount,
      });
    } catch (err) {
      log.error("ways-to-edges: refresh failed", { err: (err as Error).message });
      throw err;
    }
  };
  /** Runs `steps` in order as one traffic-maintenance execution. A failed step
   * does not skip the next; the execution fails if any step failed. */
  const trafficMaintenance = (
    task: "extract-startup" | "extract-guard" | "ways-to-edges",
    ...steps: Array<() => Promise<void>>
  ): Promise<void> =>
    runLocalDataExecution(
      { kind: "traffic-maintenance", task },
      async () => {
        let failure: unknown;
        for (const step of steps) await step().catch((err: unknown) => (failure ??= err));
        if (failure) throw failure;
      },
      { trigger: "cron" },
    ).catch((err: unknown) => {
      log.error(`traffic-maintenance: ${task} failed`, { err: (err as Error).message });
    });

  // The extract exists for the traffic writers, which read OpenConditions.
  // Without them nothing uses it, and on a host without Valhalla the agent's
  // rebuild fails part way and keeps the Valhalla target held.
  const trafficExtractUnused = (phase: string): boolean => {
    if (openConditionsUrl) return false;
    log.info(`traffic-extract: ${phase} skipped (OPENCONDITIONS_URL not configured)`);
    return true;
  };

  const runWaysToEdgesRefresh = (): Promise<void> =>
    trafficMaintenance("ways-to-edges", refreshWaysToEdgesMap);

  const runTrafficExtractStartup = async (): Promise<void> => {
    if (trafficExtractUnused("startup check")) return;
    let graphRebuilt = false;
    await trafficMaintenance(
      "extract-startup",
      async () => {
        try {
          const result = await ensureExtract({ logger: log });
          graphRebuilt = result.built;
          log.info("traffic-extract: startup check complete", { built: result.built });
        } catch (err) {
          log.error("traffic-extract: startup ensure failed", { err: (err as Error).message });
          throw err;
        }
      },
      // A build (above, or the guard's rebuild) refreshes the way→edge map, but
      // a traffic.tar that already exists from a prior boot leaves the map
      // ungenerated on first run — the live writer then can't load it. Bootstrap
      // it here when it's missing so the chain works without waiting for the
      // next graph rebuild.
      async () => {
        if (!options.getCoveredWayIds || (!graphRebuilt && existsSync(waysToEdgesMapPath())))
          return;
        log.info(
          graphRebuilt
            ? "ways-to-edges: graph rebuilt at startup, refreshing map"
            : "ways-to-edges: map missing at startup, bootstrapping",
        );
        await refreshWaysToEdgesMap();
      },
    );
  };

  const runTrafficExtractGuard = async (): Promise<void> => {
    if (trafficExtractUnused("guard")) return;
    await trafficMaintenance(
      "extract-guard",
      async () => {
        try {
          const stale = await checkExtractStale({ logger: log });
          if (stale) {
            // A stale extract doesn't fail soft — Valhalla throws mid-request
            // when the traffic tile's directed_edge_count disagrees with the
            // graph tile, so rebuild eagerly rather than wait for a request to
            // surface it. `force` skips the redundant presence check: we
            // already know the file exists, just that it's outdated.
            log.info("traffic-extract: graph tiles newer than traffic.tar, rebuilding");
            const result = await ensureExtract({ logger: log, force: true });
            log.info("traffic-extract: guard rebuild complete", { built: result.built });
          } else {
            log.info("traffic-extract: guard check found no rebuild needed");
          }
        } catch (err) {
          log.error("traffic-extract: guard check failed", { err: (err as Error).message });
          throw err;
        }
      },
      // Unconditional, and a step of its own so an extract failure can't skip
      // it. The map's key set tracks the OpenConditions feed rather than the
      // graph, and the feed grows as sources are added; gating this on a
      // rebuild left it months stale while the live-speed writer silently
      // covered a shrinking share of the feed.
      refreshWaysToEdgesMap,
    );
  };

  let graphMaintenanceCheck: Promise<void> | null = null;
  const scheduleGraphMaintenanceCheck = (): void => {
    if (graphMaintenanceCheck) return;
    graphMaintenanceCheck = runTrafficExtractGuard().finally(() => {
      graphMaintenanceCheck = null;
    });
  };

  const trafficLive = createTrafficLiveService({
    options,
    dataDir: options.dataDir,
    log,
    openConditionsUrl,
    openConditionsRequest: { headers: openConditionsHeaders(openConditionsToken) },
    nextScheduledRun: () => crons.trafficLiveCron?.nextRun()?.getTime(),
    scheduleGraphMaintenanceCheck,
    refreshWaysToEdges: runWaysToEdgesRefresh,
  });

  const bake = options.bakePredicted ?? bakePredictedDefault;

  // Bakes OpenConditions' historical profiles into the loose graph tiles and
  // runs the full downstream rebuild chain (traffic.tar + way-to-edge map +
  // Valhalla restart) itself — this cron just gates on configuration and logs
  // the result, mirroring the live-traffic cron's shape.
  const runTrafficPredicted = async (): Promise<void> => {
    if (!openConditionsUrl) {
      log.info("traffic-predicted: skipped (OPENCONDITIONS_URL not configured)");
      return;
    }
    try {
      const result = await runLocalDataExecution(
        { kind: "traffic-predicted" },
        () => bake({ openConditionsUrl, openConditionsToken, logger: log }),
        { trigger: "cron" },
      );
      log.info("traffic-predicted: cycle complete", { ...result });
    } catch (err) {
      log.error("traffic-predicted: cycle failed", { err: (err as Error).message });
    }
  };

  const overtureExpr = overtureEnabled
    ? pickCronExpression(options.overtureCronExpression, "OVERTURE_SYNC_CRON", "0 5 * * 2")
    : null;
  const trafficLiveExpr = pickCronExpression(
    options.trafficLiveCronExpression,
    "TRAFFIC_LIVE_CRON",
    TRAFFIC_LIVE_CRON_DEFAULT,
  );
  const trafficPredictedExpr = pickCronExpression(
    options.trafficPredictedCronExpression,
    "TRAFFIC_PREDICTED_CRON",
    TRAFFIC_PREDICTED_CRON_DEFAULT,
  );

  const schedule: Record<keyof CronJobs, ScheduledJob> = {
    syncCron: {
      name: "transitous-sync",
      expression: pickCronExpression(
        options.syncCronExpression,
        "TRANSITOUS_SYNC_CRON",
        TRANSITOUS_SYNC_CRON_DEFAULT,
      ),
      run: runSync,
      onReject: { level: "error", message: "transitous-cron: unexpected runSync rejection" },
      scheduled: "transitous-cron: sync scheduled",
      disabled: "transitous-cron: sync disabled by env",
    },
    feedProxyReloadCron: {
      name: "transitous-feed-proxy-reload",
      expression: pickCronExpression(
        options.feedProxyReloadCronExpression,
        "TRANSITOUS_FEED_PROXY_RELOAD_CRON",
        TRANSITOUS_FEED_PROXY_RELOAD_CRON_DEFAULT,
      ),
      run: runFeedProxyReload,
      onReject: { level: "warn", message: "transitous-cron: feed-proxy heartbeat threw" },
      scheduled: "transitous-cron: feed-proxy reload scheduled",
      disabled: "transitous-cron: feed-proxy reload disabled by env",
    },
    stalenessCheckCron: {
      name: "transitous-staleness-check",
      expression: pickCronExpression(
        options.stalenessCheckCronExpression,
        "TRANSITOUS_STALENESS_CHECK_CRON",
        TRANSITOUS_STALENESS_CHECK_CRON_DEFAULT,
      ),
      run: runStalenessCheck,
      onReject: { level: "warn", message: "transitous-cron: staleness check threw" },
      scheduled: "transitous-cron: staleness check scheduled",
      scheduledDetails: { githubIssueSink: githubIssue !== null },
      disabled: "transitous-cron: staleness check disabled by env",
    },
    autoBumpCron: {
      name: "transitous-auto-bump",
      expression: pickOptInCronExpression(
        options.autoBumpCronExpression,
        "TRANSITOUS_AUTO_BUMP_CRON",
      ),
      run: runAutoBump,
      onReject: { level: "error", message: "transitous-auto-bump: unexpected rejection" },
      scheduled: "transitous-auto-bump: scheduled",
      disabled: "transitous-auto-bump: disabled (opt-in; set TRANSITOUS_AUTO_BUMP_CRON)",
    },
    overtureCron: {
      name: "overture-release-sync",
      expression: overtureExpr,
      run: runOvertureSync,
      onReject: { level: "error", message: "overture-cron: unexpected rejection" },
      scheduled: "overture-cron: scheduled",
      disabled: overtureEnabled
        ? "overture-cron: disabled by cron expression sentinel"
        : "overture-cron: disabled (OVERTURE_ENABLED not set or false)",
    },
    overtureConflationRetryCron: {
      name: "overture-conflation-retry",
      expression: overtureEnabled
        ? pickCronExpression(
            options.overtureConflationRetryCronExpression,
            "OVERTURE_CONFLATION_RETRY_CRON",
            "*/15 * * * *",
          )
        : null,
      run: runOvertureConflationRetry,
      onReject: { level: "error", message: "overture-conflation: unexpected rejection" },
      scheduled: "overture-conflation: independent retry scheduled",
      disabled: "overture-conflation: independent retry cron disabled",
    },
    trafficExtractCron: {
      name: "valhalla-traffic-extract-guard",
      expression: pickCronExpression(
        options.trafficExtractCronExpression,
        "TRAFFIC_EXTRACT_CRON",
        TRAFFIC_EXTRACT_CRON_DEFAULT,
      ),
      run: runTrafficExtractGuard,
      onReject: { level: "error", message: "traffic-extract: guard cron threw" },
      scheduled: "traffic-extract: guard cron scheduled",
      disabled: "traffic-extract: guard cron disabled by env",
    },
    trafficLiveCron: {
      name: "traffic-live",
      expression: openConditionsUrl ? trafficLiveExpr : null,
      run: trafficLive.run,
      onReject: { level: "error", message: "traffic-live: cron threw" },
      scheduled: "traffic-live: scheduled",
      disabled: !trafficLiveExpr
        ? "traffic-live: disabled by env"
        : "traffic-live: disabled (OPENCONDITIONS_URL not configured)",
    },
    trafficPredictedCron: {
      name: "traffic-predicted",
      expression: openConditionsUrl ? trafficPredictedExpr : null,
      run: runTrafficPredicted,
      onReject: { level: "error", message: "traffic-predicted: cron threw" },
      scheduled: "traffic-predicted: scheduled",
      disabled: !trafficPredictedExpr
        ? "traffic-predicted: disabled by env"
        : "traffic-predicted: disabled (OPENCONDITIONS_URL not configured)",
    },
  };
  // Started, and their schedules logged, in this order.
  const crons: CronJobs = {
    syncCron: startJob(schedule.syncCron, log),
    feedProxyReloadCron: startJob(schedule.feedProxyReloadCron, log),
    stalenessCheckCron: startJob(schedule.stalenessCheckCron, log),
    autoBumpCron: startJob(schedule.autoBumpCron, log),
    overtureCron: startJob(schedule.overtureCron, log),
    overtureConflationRetryCron: startJob(schedule.overtureConflationRetryCron, log),
    trafficExtractCron: startJob(schedule.trafficExtractCron, log),
    trafficLiveCron: startJob(schedule.trafficLiveCron, log),
    trafficPredictedCron: startJob(schedule.trafficPredictedCron, log),
  };

  function stop(): void {
    void trafficLive
      .closeWriter()
      .catch((err) => log.warn("traffic-live: writer shutdown failed", { err }));
    for (const cron of Object.values(crons)) cron?.stop();
    trafficLive.stop();
  }

  return {
    ...crons,
    stop,
    trafficLive,
    runSyncNow: runSync,
    runFeedProxyReloadNow: runFeedProxyReload,
    runStalenessCheckNow: runStalenessCheck,
    runOvertureNow: runOvertureSync,
    runOvertureConflationRetryNow: runOvertureConflationRetry,
    runOvertureStartupNow: runOvertureStartup,
    runTrafficExtractStartupNow: runTrafficExtractStartup,
    runTrafficExtractGuardNow: runTrafficExtractGuard,
    runWaysToEdgesRefreshNow: runWaysToEdgesRefresh,
    runTrafficPredictedNow: runTrafficPredicted,
    runAutoBumpNow: runAutoBump,
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

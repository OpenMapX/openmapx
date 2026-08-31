import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { envString } from "@openmapx/core/server-env";
import { feedState } from "@openmapx/db-schema";
import {
  FEED_PROXY_CONFIG_FILENAME,
  FEED_PROXY_CONFIG_SUBDIR,
} from "@openmapx/motis-feed-proxy-config";
import { parseTransitSource } from "@openmapx/transitous-core";
import { Cron } from "croner";
import { and, eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { db } from "./db/index.js";
import { createGithubIssueSink, type GithubIssueSink } from "./jobs/github-issue-sink.js";
import { discoverLatestOvertureRelease } from "./jobs/overture/pull.js";
import { rebuildOvertureLinks } from "./jobs/overture/rebuild-links.js";
import {
  compareOvertureReleases,
  finalizeOvertureReleaseFiles,
  overtureReleaseRetentionFromEnv,
} from "./jobs/overture/retention.js";
import { syncOvertureRegion } from "./jobs/overture/sync.js";
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
import {
  loadWaysToEdges as loadWaysToEdgesDefault,
  type RefreshWaysToEdgesResult,
  refreshWaysToEdges as refreshWaysToEdgesDefault,
  type WayEdge,
  defaultOutputPath as waysToEdgesMapPath,
} from "./jobs/traffic/ways-to-edges.js";
import {
  type WriteLiveTrafficResult,
  writeLiveTraffic as writeLiveTrafficDefault,
} from "./jobs/traffic/write-live.js";
import {
  type CatalogBumpCandidate,
  candidateMatchesLock,
  lockFromCandidate,
  resolveCatalogBumpCandidate,
} from "./jobs/transitous/catalog-bump.js";
import {
  buildJobContext,
  type RunPipelineResult,
  runTransitousPipeline,
} from "./jobs/transitous/index.js";
import { fetchWithTimeout } from "./jobs/transitous/motis-probe.js";
import type { MotisOperationsPolicy } from "./jobs/transitous/operations-profile.js";
import { finalizeJobRow, makePersistingOnStageComplete } from "./jobs/transitous/persistence.js";
import type { SingleFlightController } from "./jobs/transitous/single-flight.js";
import {
  detectStaleFeeds,
  emitFeedAlerts,
  emitPipelineFailureAlert,
} from "./jobs/transitous/staleness-alerts.js";
import { asJobLogger, jobChildLogger } from "./logger.js";
import { runOpsOperation } from "./ops-client.js";
import type { StateStore } from "./state.js";

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
 * minutes — frequent enough that live speeds feel current, infrequent enough
 * that a slow OpenConditions response never overlaps the next tick under
 * `protect: true`.
 */
const TRAFFIC_LIVE_CRON_DEFAULT = "*/2 * * * *";
/** Bounds a single OpenConditions speed-feed fetch; mirrors `fetchJson`'s default. */
const TRAFFIC_LIVE_FETCH_TIMEOUT_MS = 10_000;
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

// Sentinel values that disable a cron entirely. Empty string is NOT one of
// them: compose injects `${VAR:-}` as "" when the operator hasn't set the var,
// and that must fall through to the built-in default (handled in
// pickCronExpression), not silently disable the schedule.
const DISABLED_SENTINELS = new Set(["disabled", "off", "false"]);

const AUTO_BUMP_PROPOSAL_COMMENT =
  "Candidate Transitous pin under auto-bump canary validation (services/data-manager).";
export interface CronLogger {
  info: (msg: string, extra?: Record<string, unknown>) => void;
  warn: (msg: string, extra?: Record<string, unknown>) => void;
  error: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface CronSetupOptions {
  dataDir: string;
  repoRoot: string;
  countries: string[];
  operationsPolicy?: MotisOperationsPolicy;
  store: StateStore;
  singleFlight: SingleFlightController;
  logger: FastifyBaseLogger | CronLogger;
  /**
   * Test seam: invoked instead of the real Transitous pipeline. Production
   * callers omit this and get `runTransitousPipeline`.
   */
  runPipeline?: (jobId: string) => Promise<RunPipelineResult>;
  /**
   * Test seam: invoked instead of the typed agent operation so the
   * unit suite never shells out to docker.
   */
  reloadFeedProxy?: (candidateId: string) => Promise<void>;
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
  /** Test seam: run the Overture update for a resolved release. */
  syncOvertureRelease?: typeof syncOvertureRegion;
  /** Test seam: rebuild links for the installed release without re-importing Places. */
  rebuildOvertureLinks?: typeof rebuildOvertureLinks;
  /** Test seam: persist successful Overture release state. */
  writeOvertureFeedState?: typeof writeFeedState;
  /** Test seam: finalize successful release-file retention after any completion path. */
  finalizeOvertureReleaseFiles?: typeof finalizeOvertureReleaseFiles;
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
   * data-manager's own view of the same `traffic.tar` file the Valhalla
   * container mmaps. They don't share a container filesystem — Valhalla mounts
   * host `data/valhalla/osm-pbf` at `/custom_files` (its `osm-pbf` consume
   * mount), and data-manager reaches that SAME host dir through its own `/data`
   * mount. Defaults to `TRAFFIC_TAR_PATH`, then `<dataDir>/valhalla/osm-pbf/
   * traffic.tar` — the host path Valhalla's `/custom_files/traffic.tar`
   * resolves to. NOT data-manager's `/data/osm` produce dir (a separate
   * hardlink target Valhalla only sees after an explicit `POST /link`).
   */
  trafficTarPath?: string;
  /** Where `writeLiveTraffic` persists its staleness state. Test seam; production uses the function's own default. */
  trafficLiveStatePath?: string;
  /**
   * Test seam: invoked instead of a real `fetch()` against
   * `${openConditionsUrl}/segments/speed.csv`.
   */
  fetchLiveTrafficCsv?: () => Promise<string>;
  /**
   * Test seam: invoked instead of the real `loadWaysToEdges` (which reads
   * the JSON map `refreshWaysToEdges` last wrote to disk).
   */
  loadWaysToEdges?: () => Promise<Map<number, WayEdge[]>>;
  /**
   * Test seam: invoked instead of the real `writeLiveTraffic` (which opens
   * `trafficTarPath` for in-place writes).
   */
  writeLiveTraffic?: (deps: {
    tarPath: string;
    csv: string;
    waysToEdges: Map<number, WayEdge[]>;
    statePath?: string;
    logger?: { warn: (msg: string, extra?: Record<string, unknown>) => void };
  }) => Promise<WriteLiveTrafficResult>;
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
  /**
   * Test seam: run the canary + promote pipeline against the proposed lock.
   * Resolves to the pipeline result; rejects when a critical stage (incl. the
   * canary) fails. Production callers omit this and get a real pipeline run
   * with `useProposedLock: true`.
   */
  runBumpPipeline?: (jobId: string) => Promise<RunPipelineResult>;
}

export interface CronHandles {
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
  /** Stop all cron jobs; awaitable shutdown lives on the caller. */
  stop: () => void;
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
  /** Test seam: directly invoke the live-traffic writer as if the cron fired. */
  runTrafficLiveNow: () => Promise<void>;
  /** Test seam: directly invoke the predicted-traffic bake as if the cron fired. */
  runTrafficPredictedNow: () => Promise<void>;
  /** Test seam: directly invoke the auto-bump handler as if the cron fired. */
  runAutoBumpNow: () => Promise<void>;
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

/**
 * Opt-in variant of {@link pickCronExpression}: an unset OR empty value means
 * DISABLED (returns null), not a built-in default. Used for the auto-bump cron,
 * which stays off unless an operator sets a schedule — the pinned catalog is a
 * deliberate safety gate, so tracking upstream is an explicit choice.
 */
function pickOptInCronExpression(override: string | undefined, envName: string): string | null {
  const raw = override ?? process.env[envName];
  if (raw === undefined || raw.trim() === "") return null;
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
        .set({
          hash,
          lastFetchedAt: new Date(),
          lastImportedAt: new Date(),
          validationStatus: "ok",
          validationMessage: `Imported Overture release ${hash}`,
          consecutiveFailures: 0,
          status: "active",
        })
        .where(eq(feedState.id, existing[0].id));
    } else {
      await db.insert(feedState).values({
        region: feedRegion,
        name: feedName,
        hash,
        lastFetchedAt: new Date(),
        lastImportedAt: new Date(),
        validationStatus: "ok",
        validationMessage: `Imported Overture release ${hash}`,
        consecutiveFailures: 0,
        status: "active",
      });
    }
  } catch (err) {
    log.warn("overture-cron: feed_state write failed", { err: (err as Error).message });
  }
}

export async function getInstalledOvertureRelease(): Promise<string | null> {
  try {
    const rows = await db.execute<{ release: string }>(
      `SELECT release
       FROM overture_places.places
       ORDER BY imported_at DESC
       LIMIT 1`,
    );
    return rows[0]?.release ?? null;
  } catch {
    return null;
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
    let pipelineResult: RunPipelineResult | undefined;
    let threwReason: string | undefined;
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
          operationsPolicy: options.operationsPolicy,
          jobId: start.jobId,
          logger: jobLog,
          onStageComplete: makePersistingOnStageComplete(start.jobId, jobLog),
        });
        result = await runTransitousPipeline(ctx);
      }
      pipelineResult = result;
      finalStatus = result.finalStatus;
      log.info("transitous-cron: sync completed", {
        jobId: start.jobId,
        finalStatus,
        stageCount: result.results.length,
      });
    } catch (err) {
      threwReason = (err as Error).message;
      log.error("transitous-cron: sync threw", {
        jobId: start.jobId,
        err: threwReason,
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

    // A hard failure means the canary rejected the candidate (or a critical
    // stage errored) and nothing promoted — the live dataset silently ages.
    // Per-feed staleness can't catch this in mirror mode (feed_state is written
    // before the canary), so surface it as its own pipeline-level alert.
    if (finalStatus === "error") {
      const failed = pipelineResult?.results.find((stage) => stage.status === "error");
      try {
        await emitPipelineFailureAlert({
          alert: {
            trigger: "cron",
            jobId: start.jobId,
            failedStage: failed?.stage,
            reason: failed?.error?.message ?? failed?.message ?? threwReason ?? "sync failed",
          },
          log,
          githubIssue: githubIssue ?? undefined,
        });
      } catch (err) {
        log.warn("transitous-cron: pipeline failure alert failed", {
          jobId: start.jobId,
          err: (err as Error).message,
        });
      }
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

  const catalogDir = join(options.dataDir, ".transitous-catalog");
  const resolveBumpCandidate =
    options.resolveBumpCandidate ?? ((o) => resolveCatalogBumpCandidate(o));
  const defaultRunBumpPipeline = async (jobId: string): Promise<RunPipelineResult> => {
    const jobLog = asJobLogger(
      jobChildLogger({ job: "transitous-auto-bump", jobId, trigger: "cron" }),
    );
    const ctx = buildJobContext({
      dataDir: options.dataDir,
      store: options.store,
      countries: options.countries,
      repoRoot: options.repoRoot,
      source: parseTransitSource(),
      operationsPolicy: options.operationsPolicy,
      jobId,
      logger: jobLog,
      useProposedLock: true,
      onStageComplete: makePersistingOnStageComplete(jobId, jobLog),
    });
    return runTransitousPipeline(ctx);
  };
  const runBumpPipeline = options.runBumpPipeline ?? defaultRunBumpPipeline;

  /**
   * Auto-bump the pinned Transitous catalog behind the pipeline's own canary.
   * Resolve upstream → propose the candidate → build it into the staging slot
   * and run the functional-probe canary → activate the pin only if the whole
   * pipeline (incl. the live promote) succeeds. On rejection the active pin is
   * untouched, the proposal is retained for review, and a failure alert fires.
   */
  const runAutoBump = async (): Promise<void> => {
    const start = await options.singleFlight.tryStartSync({
      trigger: "cron",
      triggeredBy: "data-manager-auto-bump",
      kind: "transitous-auto-bump",
      metadata: { source: "auto-bump" },
    });
    if (!start.ok) {
      log.warn("transitous-auto-bump: skipped, a sync is in-flight", { reason: start.reason });
      return;
    }

    let finalStatus: RunPipelineResult["finalStatus"] = "ok";
    let pipelineResult: RunPipelineResult | undefined;
    let threwReason: string | undefined;
    let ranPipeline = false;
    try {
      const candidate = await resolveBumpCandidate({ catalogDir, branch: "main" });
      const { active } = await runOpsOperation({ kind: "transitousLock.inspect" });
      if (candidateMatchesLock(candidate, active)) {
        log.info("transitous-auto-bump: already at upstream tip; nothing to do", {
          ref: candidate.ref,
        });
        return;
      }
      log.info("transitous-auto-bump: proposing candidate pin", {
        ref: candidate.ref,
        previousRef: active?.ref ?? null,
      });
      const proposal = lockFromCandidate(candidate, "auto-bump", AUTO_BUMP_PROPOSAL_COMMENT);
      // Agent-owned write: the auto-bump proposes, it never activates.
      await runOpsOperation({
        kind: "transitousLock.propose",
        ref: proposal.ref,
        submodules: proposal.submodules,
        lockedBy: proposal.lockedBy,
        comment: AUTO_BUMP_PROPOSAL_COMMENT,
      });

      ranPipeline = true;
      pipelineResult = await runBumpPipeline(start.jobId);
      finalStatus = pipelineResult.finalStatus;

      if (finalStatus === "ok") {
        // Only a passing canary activates, and the agent re-matches the exact
        // ref it is activating.
        await runOpsOperation({
          kind: "transitousLock.approve",
          ref: candidate.ref,
          approvedBy: "auto-bump",
        });
        log.info("transitous-auto-bump: canary passed; activated new catalog pin", {
          ref: candidate.ref,
        });
      } else {
        log.warn("transitous-auto-bump: canary did not fully pass; keeping current pin", {
          ref: candidate.ref,
          finalStatus,
        });
      }
    } catch (err) {
      // A canary rejection surfaces here (the pipeline rethrows on a critical
      // stage). Keep the active pin and retain the proposal for review.
      threwReason = (err as Error).message;
      finalStatus = "error";
      log.error("transitous-auto-bump: failed", { err: threwReason });
    } finally {
      try {
        await finalizeJobRow(start.jobId, finalStatus);
      } catch (err) {
        log.warn("transitous-auto-bump: finalizeJobRow failed", {
          jobId: start.jobId,
          err: (err as Error).message,
        });
      }
      options.singleFlight.markSyncFinished();
    }

    if (ranPipeline && finalStatus !== "ok") {
      const failed = pipelineResult?.results.find((stage) => stage.status === "error");
      try {
        await emitPipelineFailureAlert({
          alert: {
            trigger: "auto-bump",
            jobId: start.jobId,
            failedStage: failed?.stage,
            reason:
              failed?.error?.message ?? failed?.message ?? threwReason ?? "auto-bump canary failed",
          },
          log,
          githubIssue: githubIssue ?? undefined,
        });
      } catch (err) {
        log.warn("transitous-auto-bump: failure alert failed", {
          jobId: start.jobId,
          err: (err as Error).message,
        });
      }
    }
  };

  const defaultReload = async (candidateId: string): Promise<void> => {
    // The agent validates the configuration before reloading and owns the
    // container name; data-manager only names the candidate.
    await runOpsOperation({ kind: "feedProxy.validateAndReload", candidateId });
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
      const reload = options.reloadFeedProxy ?? defaultReload;
      // The config file's mtime identifies the candidate being activated.
      await reload(`feedproxy-${Math.trunc(mtimeMs)}`);
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

  const autoBumpExpr = pickOptInCronExpression(
    options.autoBumpCronExpression,
    "TRANSITOUS_AUTO_BUMP_CRON",
  );
  const autoBumpCron = autoBumpExpr
    ? new Cron(autoBumpExpr, { name: "transitous-auto-bump", protect: true }, () => {
        void runAutoBump().catch((err) => {
          log.error("transitous-auto-bump: unexpected rejection", { err: (err as Error).message });
        });
      })
    : null;
  if (!autoBumpCron)
    log.info("transitous-auto-bump: disabled (opt-in; set TRANSITOUS_AUTO_BUMP_CRON)");
  else log.info("transitous-auto-bump: scheduled", { expression: autoBumpExpr });

  const overtureEnabled =
    options.overtureEnabled ?? (process.env.OVERTURE_ENABLED || "").trim().toLowerCase() === "true";

  const overtureExpr = overtureEnabled
    ? pickCronExpression(options.overtureCronExpression, "OVERTURE_SYNC_CRON", "0 5 * * 2")
    : null;
  const overtureConflationRetryExpr = overtureEnabled
    ? pickCronExpression(
        options.overtureConflationRetryCronExpression,
        "OVERTURE_CONFLATION_RETRY_CRON",
        "*/15 * * * *",
      )
    : null;

  const runOvertureConflationRetry = async (): Promise<void> => {
    const region =
      options.overtureRegion ?? (process.env.OPENMAPX_REGION || "europe/germany/berlin");
    const readInstalledRelease = options.getInstalledOvertureRelease ?? getInstalledOvertureRelease;
    const rebuildLinks = options.rebuildOvertureLinks ?? rebuildOvertureLinks;
    const finalizeReleaseFiles =
      options.finalizeOvertureReleaseFiles ?? finalizeOvertureReleaseFiles;
    try {
      const release = await readInstalledRelease();
      if (!release) {
        log.info("overture-conflation: no installed Places release; nothing to rebuild", {
          region,
        });
        return;
      }
      const result = await rebuildLinks({
        region,
        release,
        dataDir: options.dataDir,
        onProgress: (msg) => log.info(msg),
      });
      if (result.status === "failed") {
        log.error("overture-conflation: rebuild failed and remains retryable", {
          region,
          release,
          err: result.error,
        });
      } else {
        if (result.status === "completed" || result.status === "already_completed") {
          await finalizeReleaseFiles({
            dataDir: options.dataDir,
            activeRelease: release,
            retain: overtureReleaseRetentionFromEnv(process.env.OVERTURE_RELEASE_RETENTION),
            onProgress: (msg) => log.info(msg),
          });
        }
        log.info("overture-conflation: retry check complete", {
          region,
          release,
          status: result.status,
          linked: result.linked,
        });
      }
    } catch (err) {
      log.error("overture-conflation: retry check failed", { err: (err as Error).message });
    }
  };

  const runOvertureSync = async (): Promise<void> => {
    const region =
      options.overtureRegion ?? (process.env.OPENMAPX_REGION || "europe/germany/berlin");
    const discoverRelease = options.discoverOvertureRelease ?? discoverLatestOvertureRelease;
    const readInstalledRelease = options.getInstalledOvertureRelease ?? getInstalledOvertureRelease;
    const syncRelease = options.syncOvertureRelease ?? syncOvertureRegion;
    const persistFeedState = options.writeOvertureFeedState ?? writeFeedState;
    try {
      const release = await discoverRelease();
      const installedRelease = await readInstalledRelease();
      if (installedRelease === release) {
        log.info("overture-cron: latest Places release already installed; checking links", {
          region,
          release,
        });
        await runOvertureConflationRetry();
        return;
      }
      if (installedRelease && compareOvertureReleases(installedRelease, release) > 0) {
        log.warn("overture-cron: installed release is newer than upstream catalog", {
          region,
          installedRelease,
          upstreamRelease: release,
        });
        return;
      }

      const result = await syncRelease({
        region,
        release,
        dataDir: options.dataDir,
        onProgress: (msg) => log.info(msg),
      });
      await persistFeedState(region, release, log);
      await runStalenessCheck();
      if (result.conflation === "failed") {
        log.error("overture-cron: Places imported; link rebuild will retry independently", {
          region,
          release,
          err: result.conflationError,
        });
      }
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
    overtureCron = new Cron(overtureExpr, { name: "overture-release-sync", protect: true }, () =>
      runOvertureSync().catch((err) => {
        log.error("overture-cron: unexpected rejection", { err: (err as Error).message });
      }),
    );
    log.info("overture-cron: scheduled", { expression: overtureExpr });
  }

  let overtureConflationRetryCron: Cron | null = null;
  if (!overtureEnabled || !overtureConflationRetryExpr) {
    log.info("overture-conflation: independent retry cron disabled");
  } else {
    overtureConflationRetryCron = new Cron(
      overtureConflationRetryExpr,
      { name: "overture-conflation-retry", protect: true },
      () =>
        runOvertureConflationRetry().catch((err) => {
          log.error("overture-conflation: unexpected rejection", {
            err: (err as Error).message,
          });
        }),
    );
    log.info("overture-conflation: independent retry scheduled", {
      expression: overtureConflationRetryExpr,
    });
  }

  const ensureExtract = options.ensureTrafficExtract ?? ensureTrafficExtract;
  const checkExtractStale = options.isTrafficExtractStale ?? isTrafficExtractStale;

  const refreshWaysToEdges = options.refreshWaysToEdges ?? refreshWaysToEdgesDefault;

  // The way_id → GraphId map is refreshed from the current OpenConditions key
  // set so both traffic writers see ways added since the last graph rebuild.
  const runWaysToEdgesRefresh = async (): Promise<void> => {
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
    }
  };

  const runTrafficExtractStartup = async (): Promise<void> => {
    try {
      const result = await ensureExtract({ logger: log });
      log.info("traffic-extract: startup check complete", { built: result.built });
    } catch (err) {
      log.error("traffic-extract: startup ensure failed", { err: (err as Error).message });
    }
    // A build (above, or the guard's rebuild) refreshes the way→edge map, but a
    // traffic.tar that already exists from a prior boot leaves the map ungenerated
    // on first run — the live writer then can't load it. Bootstrap it here when
    // it's missing so the chain works without waiting for the next graph rebuild.
    if (options.getCoveredWayIds && !existsSync(waysToEdgesMapPath())) {
      log.info("ways-to-edges: map missing at startup, bootstrapping");
      await runWaysToEdgesRefresh();
    }
  };

  const runTrafficExtractGuard = async (): Promise<void> => {
    try {
      const stale = await checkExtractStale({ logger: log });
      if (stale) {
        // A stale extract doesn't fail soft — Valhalla throws mid-request when
        // the traffic tile's directed_edge_count disagrees with the graph
        // tile, so rebuild eagerly rather than wait for a request to surface
        // it. `force` skips the redundant presence check: we already know the
        // file exists, just that it's outdated.
        log.info("traffic-extract: graph tiles newer than traffic.tar, rebuilding");
        const result = await ensureExtract({ logger: log, force: true });
        log.info("traffic-extract: guard rebuild complete", { built: result.built });
      } else {
        log.info("traffic-extract: guard check found no rebuild needed");
      }
    } catch (err) {
      log.error("traffic-extract: guard check failed", { err: (err as Error).message });
    }

    // Unconditional, and outside the try above so an extract failure can't skip
    // it. The map's key set tracks the OpenConditions feed rather than the
    // graph, and the feed grows as sources are added; gating this on a rebuild
    // left it months stale while the live-speed writer silently covered a
    // shrinking share of the feed. runWaysToEdgesRefresh contains its own
    // error handling.
    await runWaysToEdgesRefresh();
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

  const openConditionsUrl = options.openConditionsUrl ?? envString("OPENCONDITIONS_URL", "");
  const trafficTarPath =
    options.trafficTarPath ??
    envString("TRAFFIC_TAR_PATH", join(options.dataDir, "valhalla", "osm-pbf", "traffic.tar"));

  const fetchLiveTrafficCsv =
    options.fetchLiveTrafficCsv ??
    (async (): Promise<string> => {
      const res = await fetchWithTimeout(
        `${openConditionsUrl}/segments/speed.csv`,
        TRAFFIC_LIVE_FETCH_TIMEOUT_MS,
      );
      if (!res.ok) {
        throw new Error(`traffic-live: OpenConditions speed feed responded ${res.status}`);
      }
      return res.text();
    });

  const loadCoveredWaysToEdges = options.loadWaysToEdges ?? (() => loadWaysToEdgesDefault());
  const writeLive = options.writeLiveTraffic ?? writeLiveTrafficDefault;

  // The writer's own module owns the covered-way-id staleness state; this
  // cron just wires fetch → load → write together and logs the match rate.
  // A falling matched/total ratio over time signals OSM-vintage drift
  // between OpenConditions' spine and this deployment's Valhalla graph.
  const runTrafficLive = async (): Promise<void> => {
    if (!openConditionsUrl) {
      log.info("traffic-live: skipped (OPENCONDITIONS_URL not configured)");
      return;
    }
    try {
      const csv = await fetchLiveTrafficCsv();
      let waysToEdges: Map<number, WayEdge[]>;
      try {
        waysToEdges = await loadCoveredWaysToEdges();
      } catch (err) {
        // Expected transient right after boot: the startup way→edge bootstrap
        // runs fire-and-forget, so an early cron fire can precede the map write.
        // Skip quietly (info, not error) — the next cycle picks it up.
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          log.info("traffic-live: way-to-edge map not ready yet, skipping cycle");
          return;
        }
        throw err;
      }
      const result = await writeLive({
        tarPath: trafficTarPath,
        csv,
        waysToEdges,
        statePath: options.trafficLiveStatePath,
        logger: log,
      });
      const matchRatePct =
        result.total > 0 ? Number(((result.matched / result.total) * 100).toFixed(1)) : null;
      log.info("traffic-live: cycle complete", {
        written: result.written,
        matched: result.matched,
        total: result.total,
        matchRatePct,
        outOfBounds: result.outOfBounds,
      });
      // A non-zero out-of-bounds count means waysToEdges references edges the
      // current traffic.tar doesn't have — a version mismatch the daily
      // extract-guard cron resolves by rebuilding both.
      if (result.outOfBounds > 0) {
        log.warn("traffic-live: skipped out-of-range edges (traffic.tar/waysToEdges mismatch)", {
          outOfBounds: result.outOfBounds,
        });
      }
    } catch (err) {
      log.error("traffic-live: cycle failed", { err: (err as Error).message });
    }
  };

  const trafficLiveExpr = pickCronExpression(
    options.trafficLiveCronExpression,
    "TRAFFIC_LIVE_CRON",
    TRAFFIC_LIVE_CRON_DEFAULT,
  );

  const trafficLiveCron =
    trafficLiveExpr && openConditionsUrl
      ? new Cron(trafficLiveExpr, { name: "traffic-live", protect: true }, () => {
          void runTrafficLive().catch((err) => {
            log.error("traffic-live: cron threw", { err: (err as Error).message });
          });
        })
      : null;

  if (!trafficLiveCron) {
    log.info(
      !trafficLiveExpr
        ? "traffic-live: disabled by env"
        : "traffic-live: disabled (OPENCONDITIONS_URL not configured)",
    );
  } else {
    log.info("traffic-live: scheduled", { expression: trafficLiveExpr });
  }

  const bake = options.bakePredicted ?? bakePredictedDefault;

  // Bakes OpenConditions' historical profiles into the loose graph tiles and
  // runs the full downstream rebuild chain (traffic.tar + way-to-edge map +
  // Valhalla restart) itself — this cron just gates on configuration and logs
  // the result, mirroring the live-traffic cron's shape above.
  const runTrafficPredicted = async (): Promise<void> => {
    if (!openConditionsUrl) {
      log.info("traffic-predicted: skipped (OPENCONDITIONS_URL not configured)");
      return;
    }
    try {
      const result = await bake({ openConditionsUrl, logger: log });
      log.info("traffic-predicted: cycle complete", { ...result });
    } catch (err) {
      log.error("traffic-predicted: cycle failed", { err: (err as Error).message });
    }
  };

  const trafficPredictedExpr = pickCronExpression(
    options.trafficPredictedCronExpression,
    "TRAFFIC_PREDICTED_CRON",
    TRAFFIC_PREDICTED_CRON_DEFAULT,
  );

  const trafficPredictedCron =
    trafficPredictedExpr && openConditionsUrl
      ? new Cron(trafficPredictedExpr, { name: "traffic-predicted", protect: true }, () => {
          void runTrafficPredicted().catch((err) => {
            log.error("traffic-predicted: cron threw", { err: (err as Error).message });
          });
        })
      : null;

  if (!trafficPredictedCron) {
    log.info(
      !trafficPredictedExpr
        ? "traffic-predicted: disabled by env"
        : "traffic-predicted: disabled (OPENCONDITIONS_URL not configured)",
    );
  } else {
    log.info("traffic-predicted: scheduled", { expression: trafficPredictedExpr });
  }

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
    overtureConflationRetryCron?.stop();
    trafficExtractCron?.stop();
    trafficLiveCron?.stop();
    trafficPredictedCron?.stop();
    autoBumpCron?.stop();
  }

  return {
    syncCron,
    feedProxyReloadCron,
    stalenessCheckCron,
    overtureCron,
    overtureConflationRetryCron,
    trafficExtractCron,
    trafficLiveCron,
    trafficPredictedCron,
    autoBumpCron,
    stop,
    runSyncNow: runSync,
    runFeedProxyReloadNow: runFeedProxyReload,
    runStalenessCheckNow: runStalenessCheck,
    runOvertureNow: runOvertureSync,
    runOvertureConflationRetryNow: runOvertureConflationRetry,
    runTrafficExtractStartupNow: runTrafficExtractStartup,
    runTrafficExtractGuardNow: runTrafficExtractGuard,
    runWaysToEdgesRefreshNow: runWaysToEdgesRefresh,
    runTrafficLiveNow: runTrafficLive,
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

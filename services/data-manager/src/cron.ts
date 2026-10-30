import { createHash, randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as durableDelay } from "node:timers/promises";
import { readBoundedResponseText } from "@openmapx/core";
import type { PlannedTrafficClosures } from "@openmapx/core/data-manager-contracts";
import {
  type DataExecutionStatus,
  isDataExecutionTerminal,
} from "@openmapx/core/data-manager-contracts";

import { envInt, envString } from "@openmapx/core/server-env";
import {
  FEED_PROXY_CONFIG_FILENAME,
  FEED_PROXY_CONFIG_SUBDIR,
} from "@openmapx/motis-feed-proxy-config";
import { Cron } from "croner";
import type { FastifyBaseLogger } from "fastify";
import { z } from "zod/v4";
import { db } from "./db/index.js";
import type { DataExecutionReceiver } from "./jobs/execution/api.js";
import {
  independentLegacyDataMutation,
  withLegacyDataMutation,
} from "./jobs/execution/legacy-mutation.js";
import { createGithubIssueSink, type GithubIssueSink } from "./jobs/github-issue-sink.js";
import { discoverLatestOvertureRelease } from "./jobs/overture/pull.js";
import { compareOvertureReleases } from "./jobs/overture/retention.js";
import {
  type BakePredictedDeps,
  type BakePredictedResult,
  bakePredicted as bakePredictedDefault,
} from "./jobs/traffic/bake-predicted.js";
import {
  type BoundCondition,
  type ConditionsToEdgesResult,
  conditionRoutingDecision,
  conditionsToEdges,
  emptyConditionsToEdges,
  parseConditionsJson,
  spanKey,
} from "./jobs/traffic/conditions-to-edges.js";
import {
  type EnsureTrafficExtractResult,
  ensureTrafficExtract,
  isTrafficExtractStale,
} from "./jobs/traffic/ensure-extract.js";
import {
  recordTrafficConditionsFailure,
  recordTrafficConditionsSuccess,
  recordTrafficFlowFailure,
  recordTrafficFlowSuccess,
  recordTrafficGraphFailure,
  recordTrafficGraphSuccess,
  trafficEvidencePath as resolveTrafficEvidencePath,
} from "./jobs/traffic/evidence.js";
import { readTrafficGraphState } from "./jobs/traffic/graph-generation.js";
import { createLiveTrafficWriter } from "./jobs/traffic/live-writer-client.js";
import { openConditionsHeaders } from "./jobs/traffic/openconditions-auth.js";
import { plannedClosures } from "./jobs/traffic/planned-closures.js";
import { fetchTrafficPolicy, type TrafficPolicy } from "./jobs/traffic/policy.js";
import { buildTrafficReceipts, type TrafficApplicationSnapshot } from "./jobs/traffic/receipts.js";
import {
  loadSpanEdgeCache,
  type ResolveSpanEdgesResult,
  resolveSpanEdges,
  type SpanEdgeCache,
  type SpanEdgesDeps,
  saveSpanEdgeCache,
  traceSpanEdges as traceSpanEdgesDefault,
} from "./jobs/traffic/span-edges.js";
import {
  loadWaysToEdges as loadWaysToEdgesDefault,
  type RefreshWaysToEdgesResult,
  refreshWaysToEdges as refreshWaysToEdgesDefault,
  type WayEdge,
  defaultOutputPath as waysToEdgesMapPath,
} from "./jobs/traffic/ways-to-edges.js";
import {
  TRAFFIC_LEASE_MAX_MS,
  type WriteLiveTrafficDeps,
  type WriteLiveTrafficResult,
} from "./jobs/traffic/write-live.js";
import type { CatalogBumpCandidate } from "./jobs/transitous/catalog-bump.js";
import { fetchWithTimeout } from "./jobs/transitous/motis-probe.js";
import type { MotisOperationsPolicy } from "./jobs/transitous/operations-profile.js";
import type { SingleFlightController } from "./jobs/transitous/single-flight.js";
import {
  detectStaleFeeds,
  emitFeedAlerts,
  emitPipelineFailureAlert,
} from "./jobs/transitous/staleness-alerts.js";
import { runOpsOperation } from "./ops-client.js";
import type { StateStore } from "./state.js";
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
 * How long before a live write's lease ends the next cycle must run. A cycle
 * whose lease would end before the next tick plus this margin runs early
 * instead, and a road-event effect, policy or conditions set that ends sooner
 * than this is left out of the write: no renewal could replace it in time,
 * and a lapsed lease makes Valhalla's watchdog stop the engine.
 */
export const TRAFFIC_LEASE_RENEWAL_MS = 45_000;
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

export interface CronLogger {
  info: (msg: string, extra?: Record<string, unknown>) => void;
  warn: (msg: string, extra?: Record<string, unknown>) => void;
  error: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface CronSetupOptions {
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
  /** Versioned traffic freshness evidence path. Defaults beside the live-state file. */
  trafficEvidencePath?: string;
  /**
   * Test seam: invoked instead of a real `fetch()` against
   * `${openConditionsUrl}/segments/speed.csv`.
   */
  fetchLiveTrafficCsv?: () => Promise<string>;
  /**
   * Test seam: invoked instead of a real `fetch()` against
   * `${openConditionsUrl}/segments/conditions.json`.
   */
  fetchConditionsJson?: () => Promise<string>;
  fetchTrafficPolicy?: () => Promise<TrafficPolicy>;
  /**
   * How long the last successfully-fetched condition set stays usable after a
   * failed fetch. Defaults to `TRAFFIC_CONDITIONS_STALE_MS`.
   */
  trafficConditionsStaleMs?: number;
  /**
   * Base URL of the Valhalla container span tracing snaps against. Defaults to
   * `TRAFFIC_VALHALLA_URL`, deliberately its own variable: the app-side Valhalla
   * endpoint may point at a hosted routing service, which knows nothing about
   * this deployment's graph ids and would fail every trace.
   */
  valhallaUrl?: string;
  /**
   * Test seam: invoked instead of the real `traceSpanEdges` (which posts to
   * Valhalla's `/trace_attributes`).
   */
  traceSpanEdges?: typeof traceSpanEdgesDefault;
  /** Where the traced span→edge results persist. Defaults to `<dataDir>/traffic/span-edges-cache.json`. */
  spanEdgeCachePath?: string;
  /**
   * Test seam: invoked instead of the real `loadWaysToEdges` (which reads
   * the JSON map `refreshWaysToEdges` last wrote to disk).
   */
  loadWaysToEdges?: () => Promise<Map<number, WayEdge[]>>;
  /**
   * Test seam: invoked instead of the real `writeLiveTraffic` (which opens
   * `trafficTarPath` for in-place writes).
   */
  roadConditionsMode?: "shadow" | "active";
  readTrafficGraphGeneration?: () => Promise<string>;
  readTrafficGraphState?: () => Promise<{ generation: string; engineBootId: string }>;
  /** Fatal worker lifecycle notification; production exits for supervisor recovery. */
  onTrafficWriterFailure?: (error: Error) => void;
  writeLiveTraffic?: (deps: WriteLiveTrafficDeps) => Promise<WriteLiveTrafficResult>;
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
  /** Drain the owned live writer, then wait for thread exit. */
  closeTrafficWriter: () => Promise<void>;
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
  /**
   * `observationIds`: the observations whose EVERY override edge was ACTUALLY
   * written into `traffic.tar` during the last successful live-speed cycle,
   * sorted; `writtenAt`: when that cycle wrote them (null until the first
   * successful write). An observation with even one edge that failed to
   * resolve is absent, because a router treats presence here as "the graph
   * already reflects this event" and drops ALL of its point exclusions — a
   * partially-written event would leave its unwritten edges open and
   * unexcluded. Cap-only observations are included too — harmless, since
   * point exclusions exist only for closures.
   */
  getTrafficConditionsApplied: () => TrafficApplicationSnapshot;
  /**
   * The bound closures a car trip at `travelAt` must route around, from the
   * last good conditions set under the last policy lease; null when either is
   * stale or absent, so a caller never routes on lapsed evidence.
   */
  getPlannedClosures: (
    bbox: readonly [number, number, number, number],
    travelAt: number,
  ) => PlannedTrafficClosures | null;
  /** Test seam: directly invoke the predicted-traffic bake as if the cron fired. */
  runTrafficPredictedNow: () => Promise<void>;
  /** Test seam: directly invoke the auto-bump handler as if the cron fired. */
  runAutoBumpNow: () => Promise<void>;
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
const transitFailureSchema = z.object({
  results: z.array(
    z.object({
      stage: z.string(),
      status: z.string(),
      error: z.object({ message: z.string() }).optional(),
    }),
  ),
});
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
    if (result.status !== "ok" && result.status !== "partial")
      throw Error(`Data execution ${result.id} ${result.status}`);
    return result;
  };
  const runSync = async (): Promise<void> => {
    try {
      const admitted = await receiver().admitLocal(
        { kind: "transit-sync", countries: options.countries },
        { triggeredBy: "cron" },
      );
      log.info("transitous-cron: queued durable sync", { jobId: admitted.id });
      const result = await observeOwned(admitted);
      log.info("transitous-cron: sync settled", { jobId: result.id, status: result.status });
      if (result.status !== "ok") {
        const trusted = receiver().legacyResult(result.id),
          failure = transitFailureSchema.safeParse(trusted),
          failed = failure.success
            ? failure.data.results.find((stage) => stage.status === "error")
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
      branch: process.env.TRANSITOUS_AUTO_BUMP_BRANCH ?? "master",
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
        await receiver().admitMaintenance("reload-feed-proxy", { triggeredBy: "cron" }),
      );
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
        // Return the full job lifetime so Croner keeps overlap protection;
        // swallow rejections because `runSync` already logs internally.
        return runSync().catch((err) => {
          log.error("transitous-cron: unexpected runSync rejection", {
            err: (err as Error).message,
          });
        });
      })
    : null;

  const feedProxyReloadCron = feedProxyReloadExpr
    ? new Cron(feedProxyReloadExpr, { name: "transitous-feed-proxy-reload", protect: true }, () => {
        return runFeedProxyReload().catch((err) => {
          log.warn("transitous-cron: feed-proxy heartbeat threw", {
            err: (err as Error).message,
          });
        });
      })
    : null;

  const stalenessCheckCron = stalenessCheckExpr
    ? new Cron(stalenessCheckExpr, { name: "transitous-staleness-check", protect: true }, () => {
        return runStalenessCheck().catch((err) => {
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
        return runAutoBump().catch((err) => {
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
    const region = options.overtureRegion ?? process.env.OPENMAPX_REGION ?? "europe/germany/berlin";
    try {
      if (!(await (options.getInstalledOvertureRelease ?? getInstalledOvertureRelease)())) return;
      await requireSuccessful(
        await receiver().admitLocal({ kind: "overture-conflate", region }, { triggeredBy: "cron" }),
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
        await receiver().admitLocal({ kind: "overture-sync", region }, { triggeredBy: "cron" }),
      );
      if (result.status === "partial")
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
      const result = await withLegacyDataMutation("traffic-maintenance", () =>
        refreshWaysToEdges(coveredWayIds, { logger: log }),
      );
      log.info("ways-to-edges: refresh complete", {
        wayCount: result.wayCount,
        edgeCount: result.edgeCount,
      });
    } catch (err) {
      log.error("ways-to-edges: refresh failed", { err: (err as Error).message });
    }
  };

  const runTrafficExtractStartup = async (): Promise<void> => {
    let graphRebuilt = false;
    try {
      const result = await withLegacyDataMutation("traffic-maintenance", () =>
        ensureExtract({ logger: log }),
      );
      graphRebuilt = result.built;
      log.info("traffic-extract: startup check complete", { built: result.built });
    } catch (err) {
      log.error("traffic-extract: startup ensure failed", { err: (err as Error).message });
    }
    // A build (above, or the guard's rebuild) refreshes the way→edge map, but a
    // traffic.tar that already exists from a prior boot leaves the map ungenerated
    // on first run — the live writer then can't load it. Bootstrap it here when
    // it's missing so the chain works without waiting for the next graph rebuild.
    if (options.getCoveredWayIds && (graphRebuilt || !existsSync(waysToEdgesMapPath()))) {
      log.info(
        graphRebuilt
          ? "ways-to-edges: graph rebuilt at startup, refreshing map"
          : "ways-to-edges: map missing at startup, bootstrapping",
      );
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
        const result = await withLegacyDataMutation("traffic-maintenance", () =>
          ensureExtract({ logger: log, force: true }),
        );
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

  let graphMaintenanceCheck: Promise<void> | null = null;
  const scheduleGraphMaintenanceCheck = (): void => {
    if (graphMaintenanceCheck) return;
    graphMaintenanceCheck = independentLegacyDataMutation(
      "traffic-maintenance",
      runTrafficExtractGuard,
    ).finally(() => {
      graphMaintenanceCheck = null;
    });
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
          return runTrafficExtractGuard().catch((err) => {
            log.error("traffic-extract: guard cron threw", { err: (err as Error).message });
          });
        },
      )
    : null;

  if (!trafficExtractCron) log.info("traffic-extract: guard cron disabled by env");
  else log.info("traffic-extract: guard cron scheduled", { expression: trafficExtractExpr });

  const openConditionsUrl = options.openConditionsUrl ?? envString("OPENCONDITIONS_URL", "");
  const openConditionsToken =
    options.openConditionsToken ?? envString("OPENCONDITIONS_OPERATOR_TOKEN", "");
  const openConditionsRequest = { headers: openConditionsHeaders(openConditionsToken) };
  const trafficTarPath =
    options.trafficTarPath ??
    envString("TRAFFIC_TAR_PATH", join(options.dataDir, "valhalla", "osm-pbf", "traffic.tar"));

  const fetchLiveTrafficCsv =
    options.fetchLiveTrafficCsv ??
    (async (): Promise<string> => {
      const res = await fetchWithTimeout(
        `${openConditionsUrl}/segments/speed.csv`,
        TRAFFIC_LIVE_FETCH_TIMEOUT_MS,
        openConditionsRequest,
      );
      if (!res.ok) {
        throw new Error(`traffic-live: OpenConditions speed feed responded ${res.status}`);
      }
      return readBoundedResponseText(res, 32 * 1024 * 1024, {
        label: "OpenConditions traffic snapshot",
      });
    });

  const loadCoveredWaysToEdges = options.loadWaysToEdges ?? (() => loadWaysToEdgesDefault());
  const trafficWriter = createLiveTrafficWriter({
    onFailure: (error) => {
      log.warn("traffic-live: writer terminated; owner restart required", { error });
      options.onTrafficWriterFailure?.(error);
    },
  });
  const writeLive = options.writeLiveTraffic ?? trafficWriter.write;
  const closeTrafficWriter = () => trafficWriter.close();
  const roadConditionsMode =
    options.roadConditionsMode ??
    (envString("TRAFFIC_ROAD_CONDITIONS_MODE", "shadow") === "active" ? "active" : "shadow");
  const trafficLiveStatePath =
    options.trafficLiveStatePath ?? join(options.dataDir, "traffic", "live-state.json");
  const trafficEvidenceFile =
    options.trafficEvidencePath ?? resolveTrafficEvidencePath(trafficLiveStatePath);

  const conditionsStaleMs =
    options.trafficConditionsStaleMs ?? envInt("TRAFFIC_CONDITIONS_STALE_MS", 600_000);
  const fetchConditionsJson =
    options.fetchConditionsJson ??
    (async (): Promise<string> => {
      const res = await fetchWithTimeout(
        `${openConditionsUrl}/segments/conditions.json`,
        TRAFFIC_LIVE_FETCH_TIMEOUT_MS,
        openConditionsRequest,
      );
      if (!res.ok) {
        throw new Error(`traffic-live: OpenConditions conditions feed responded ${res.status}`);
      }
      return readBoundedResponseText(res, 32 * 1024 * 1024, {
        label: "OpenConditions traffic snapshot",
      });
    });

  // Last good conditions set, reused across a failing fetch for at most
  // `conditionsStaleMs` so one OpenConditions hiccup does not reopen every
  // closed road for a cycle; after that the closures are dropped (and the
  // router falls back to point exclusions via the applied set below).
  let lastConditions: {
    conditions: BoundCondition[];
    resolverVersion: string | null;
    fetchedAt: number;
  } | null = null;
  let trafficConditionsApplied: TrafficApplicationSnapshot = {
    schemaVersion: 1,
    mode: roadConditionsMode,
    writeId: null,
    engineBootId: null,
    providerId: "routing-valhalla",
    graphGeneration: null,
    policyRevision: null,
    validUntil: null,
    receipts: [],
    writtenAt: null,
    observationIds: [],
    resolverVersion: null,
  };
  // The last policy lease a cycle read, for request-time planned closures.
  let lastPolicy: TrafficPolicy | null = null;
  let lastMissingWaysRefreshAt = 0;
  const MISSING_WAYS_REFRESH_MIN_INTERVAL_MS = 3_600_000;

  const valhallaUrl =
    options.valhallaUrl ?? envString("TRAFFIC_VALHALLA_URL", "http://valhalla:8002");
  const spanEdgeCachePath =
    options.spanEdgeCachePath ?? join(options.dataDir, "traffic", "span-edges-cache.json");
  const traceSpan = options.traceSpanEdges ?? traceSpanEdgesDefault;
  // Read from disk once, on the first cycle after boot; every later cycle
  // works on this in-memory map and rewrites the file from it.
  let spanEdgeCache: SpanEdgeCache | null = null;

  // Never rejects: a conditions failure must degrade the closures, not the
  // live-speed write that shares this cycle.
  const currentConditions = async (): Promise<BoundCondition[]> => {
    try {
      const parsed = parseConditionsJson(await fetchConditionsJson());
      lastConditions = { ...parsed, fetchedAt: Date.now() };
      try {
        await recordTrafficConditionsSuccess(trafficEvidenceFile);
      } catch (evidenceErr) {
        log.warn("traffic-live: conditions evidence write failed", {
          err: (evidenceErr as Error).message,
        });
      }
    } catch (err) {
      try {
        await recordTrafficConditionsFailure(trafficEvidenceFile, err);
      } catch (evidenceErr) {
        log.warn("traffic-live: conditions failure evidence write failed", {
          err: (evidenceErr as Error).message,
        });
      }
      if (lastConditions && Date.now() - lastConditions.fetchedAt <= conditionsStaleMs) {
        log.warn("traffic-live: conditions fetch failed, reusing last good set", {
          err: (err as Error).message,
        });
      } else {
        lastConditions = null;
        log.warn("traffic-live: conditions fetch failed and last set is stale, dropping closures", {
          err: (err as Error).message,
        });
      }
    }
    return lastConditions?.conditions ?? [];
  };

  // The writer's own module owns the covered-way-id staleness state; this
  // cron just wires fetch → load → write together and logs the match rate.
  // A falling matched/total ratio over time signals OSM-vintage drift
  // between OpenConditions' spine and this deployment's Valhalla graph.
  let trafficLiveRunning = false;
  let leaseRenewal: NodeJS.Timeout | null = null;
  // Runs the next cycle early when this lease would lapse before the next
  // scheduled tick could renew it. Without a schedule there is no cadence to
  // fall behind.
  const scheduleLeaseRenewal = (leaseEnd: number) => {
    if (leaseRenewal) clearTimeout(leaseRenewal);
    leaseRenewal = null;
    const nextTick = trafficLiveCron?.nextRun()?.getTime();
    const renewAt = leaseEnd - TRAFFIC_LEASE_RENEWAL_MS;
    if (nextTick === undefined || renewAt >= nextTick) return;
    leaseRenewal = setTimeout(
      () => {
        leaseRenewal = null;
        void runTrafficLive().catch((err) => {
          log.error("traffic-live: lease renewal threw", { err: (err as Error).message });
        });
      },
      Math.max(0, renewAt - Date.now()),
    );
    leaseRenewal.unref?.();
  };

  const runTrafficLive = async (): Promise<void> => {
    if (trafficLiveRunning) {
      log.info("traffic-live: previous cycle still running, skipped");
      return;
    }
    trafficLiveRunning = true;
    try {
      await withLegacyDataMutation("traffic-live", runTrafficLiveCycle);
    } finally {
      trafficLiveRunning = false;
    }
  };

  const runTrafficLiveCycle = async (): Promise<void> => {
    if (!openConditionsUrl) {
      log.info("traffic-live: skipped (OPENCONDITIONS_URL not configured)");
      return;
    }
    try {
      const conditionsPromise = currentConditions();
      let csv = "way_id,dir,current_kph,free_flow_kph,los\n";
      let flowValidated = false;
      try {
        csv = await fetchLiveTrafficCsv();
        flowValidated = true;
      } catch (err) {
        try {
          await recordTrafficFlowFailure(trafficEvidenceFile, err);
        } catch (evidenceErr) {
          log.warn("traffic-live: flow failure evidence write failed", {
            err: (evidenceErr as Error).message,
          });
        }
        log.warn("traffic-live: flow unavailable; reconciling conditions independently");
      }
      try {
        if (flowValidated) await recordTrafficFlowSuccess(trafficEvidenceFile);
      } catch (evidenceErr) {
        log.warn("traffic-live: flow evidence write failed", {
          err: (evidenceErr as Error).message,
        });
      }
      const conditions = await conditionsPromise;
      const conditionsDeadline = lastConditions
        ? lastConditions.fetchedAt + conditionsStaleMs
        : null;
      let policy: TrafficPolicy | null = null;
      try {
        policy = await (options.fetchTrafficPolicy ?? fetchTrafficPolicy)();
        lastPolicy = policy;
      } catch {
        lastPolicy = null;
        log.warn("traffic-live: policy authority unavailable; withholding road-event effects");
      }
      let waysToEdges = new Map<number, WayEdge[]>();
      // Set when the engine's graph cannot be attested: every live effect waits.
      let graphUnattested = false;
      let engineGeneration: string | undefined;
      let engineBootId: string | undefined;
      const captureGraphState = async () => {
        if (options.readTrafficGraphGeneration && !options.readTrafficGraphState) {
          // Legacy test seam cannot attest a serving process.
          return {
            generation: await options.readTrafficGraphGeneration(),
            engineBootId: undefined,
          };
        }
        return (
          options.readTrafficGraphState ?? (() => readTrafficGraphState(dirname(trafficTarPath)))
        )();
      };
      try {
        // Bracket the map read: a maintenance completion must never pair old
        // graph IDs with a new engine epoch. The writer checks again under lock.
        const before = await captureGraphState();
        try {
          waysToEdges = await loadCoveredWaysToEdges();
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
          log.info("traffic-live: way-to-edge map unavailable; clearing prior effects");
        }
        const after = await captureGraphState();
        if (before.generation !== after.generation || before.engineBootId !== after.engineBootId)
          throw new Error("Traffic graph changed while loading edge map");
        engineGeneration = after.generation;
        engineBootId = after.engineBootId;
      } catch {
        log.warn(
          "traffic-live: graph generations unavailable or changed; withholding live effects",
        );
        waysToEdges = new Map();
        policy = null;
        graphUnattested = true;
        csv = "way_id,dir,current_kph,free_flow_kph,los\n";
        scheduleGraphMaintenanceCheck();
      }
      const hostGraphGeneration = createHash("sha256")
        .update(JSON.stringify([engineGeneration, [...waysToEdges]]))
        .digest("hex");
      for (const c of conditions)
        c.cacheGeneration = `${hostGraphGeneration}:${c.routingEvidence.graph_generation}:${c.routingEvidence.record_revision}`;
      // Failed partial traces remain unapplied; only complete proven spans route.
      let spans: ResolveSpanEdgesResult | null = null;
      try {
        spanEdgeCache ??= await loadSpanEdgeCache(spanEdgeCachePath);
        const spanDeps: SpanEdgesDeps = { valhallaUrl, waysToEdges, logger: log };
        spans = await resolveSpanEdges(conditions, spanEdgeCache, spanDeps, traceSpan);
      } catch (err) {
        log.warn("traffic-live: span tracing failed; partial spans remain unapplied", {
          err: (err as Error).message,
        });
      }
      // Guarded separately from tracing: classification must never abort the
      // cycle, because skipping `writeLive` would leave the previous cycle's
      // overrides alive in `traffic.tar` with no live speeds refreshed.
      let mapped: ConditionsToEdgesResult = emptyConditionsToEdges();
      // Anything ending before a renewal could replace it is left out now, so
      // no lease this write grants can lapse before the next write.
      const renewBy = Date.now() + TRAFFIC_LEASE_RENEWAL_MS;
      const lasting = conditions.filter((c) => {
        const until = conditionRoutingDecision(c).validUntil;
        return until === null || Date.parse(until) > renewBy;
      });
      // Why no condition was classified at all this cycle, so a quiet cycle
      // never reads as "nothing to close".
      const withheld = graphUnattested
        ? "graph_unattested"
        : !policy
          ? "policy_unavailable"
          : !(Date.parse(policy.validUntil) > renewBy)
            ? "policy_lease_ending"
            : conditionsDeadline === null
              ? "conditions_unavailable"
              : !(conditionsDeadline > renewBy)
                ? "conditions_stale"
                : null;
      try {
        mapped = conditionsToEdges(withheld === null ? lasting : [], waysToEdges, spans?.resolved, {
          disallowedSources: new Set(policy?.disallowedSourceIds ?? []),
          ...(policy?.rightsPolicy ? { rightsPolicy: policy.rightsPolicy } : {}),
        });
      } catch (err) {
        log.warn("traffic-live: conditions classification failed, writing no overrides", {
          err: (err as Error).message,
        });
      }
      if (
        mapped.missingWayIds.size > 0 &&
        Date.now() - lastMissingWaysRefreshAt > MISSING_WAYS_REFRESH_MIN_INTERVAL_MS
      ) {
        lastMissingWaysRefreshAt = Date.now();
        log.info("traffic-live: bound ways missing from way→edge map, scheduling refresh", {
          missing: mapped.missingWayIds.size,
        });
        // Fire-and-forget: a `valhalla_ways_to_edges` run is far slower than a
        // 2-minute cycle, and this cycle's write must not wait on it.
        void independentLegacyDataMutation("traffic-maintenance", runWaysToEdgesRefresh).catch(
          (err) => {
            log.warn("traffic-live: way→edge refresh failed", { err: (err as Error).message });
          },
        );
      }
      // Live speeds alone hold the full lease. Written road-event overrides
      // also hold it to the policy, the conditions set and each contributing
      // effect's own deadline.
      const overrides = roadConditionsMode === "active" ? mapped.overrides : new Map();
      const contributors = new Set(
        [...overrides.values()].flatMap((o) => [o.observationId, ...(o.contributorIds ?? [])]),
      );
      const overrideDeadlines =
        overrides.size === 0
          ? []
          : [
              ...(policy ? [Date.parse(policy.validUntil)] : []),
              ...(conditionsDeadline !== null ? [conditionsDeadline] : []),
              ...conditions
                .filter((c) => contributors.has(c.id))
                .flatMap((c) => {
                  const decision = conditionRoutingDecision(
                    c,
                    policy?.rightsPolicy ? { rightsPolicy: policy.rightsPolicy } : {},
                  );
                  return decision.eligible && decision.validUntil
                    ? [Date.parse(decision.validUntil)]
                    : [];
                }),
            ];
      const validUntil = new Date(
        Math.min(Date.now() + TRAFFIC_LEASE_MAX_MS, ...overrideDeadlines),
      ).toISOString();
      const writeId = randomUUID();
      const result = await writeLive({
        writeId,
        engineBootId,
        tarPath: trafficTarPath,
        validUntil,
        graphGeneration: hostGraphGeneration,
        expectedGraphGeneration:
          options.readTrafficGraphGeneration || options.readTrafficGraphState
            ? undefined
            : engineGeneration,
        csv,
        waysToEdges,
        overrides,
        statePath: trafficLiveStatePath,
        evidencePath: trafficEvidenceFile,
        logger: log,
      });
      scheduleLeaseRenewal(Date.parse(validUntil));
      // The default writer records this itself so direct writer invocations
      // also leave evidence. Custom writers use the same bounded result here.
      if (options.writeLiveTraffic) {
        try {
          await recordTrafficGraphSuccess(trafficEvidenceFile, result);
        } catch (evidenceErr) {
          log.warn("traffic-live: graph evidence write failed", {
            err: (evidenceErr as Error).message,
          });
        }
      }
      // Sourced from the WRITER, not from `mapped`: an observation whose every
      // edge failed to resolve was requested but never written, and claiming it
      // here would make a router skip an exclusion for a road that is still open.
      trafficConditionsApplied = {
        schemaVersion: 1,
        mode: roadConditionsMode,
        writeId,
        engineBootId: engineBootId ?? null,
        providerId: "routing-valhalla",
        graphGeneration: hostGraphGeneration,
        policyRevision: policy?.revision ?? null,
        validUntil,
        receipts: policy
          ? buildTrafficReceipts({
              conditions,
              overrides: mapped.overrides,
              appliedObservationIds: result.appliedObservationIds,
              graphGeneration: hostGraphGeneration,
              policyRevision: policy.revision,
              rightsPolicy: policy.rightsPolicy,
              validUntil,
            })
          : [],
        writtenAt: new Date().toISOString(),
        observationIds: result.appliedObservationIds,
        resolverVersion: lastConditions?.resolverVersion ?? null,
      };
      log.info("traffic-live: conditions applied", {
        mode: roadConditionsMode,
        candidateEdges: mapped.overrides.size,
        closedEdges: result.closedEdges,
        cappedEdges: result.cappedEdges,
        overridesUnresolved: result.overridesUnresolved,
        requestedClosures: mapped.appliedObservationIds.size,
        appliedConditions: trafficConditionsApplied.observationIds.length,
        edgeExactSpans: mapped.edgeExactSpans,
        wholeWaySpans: mapped.wholeWaySpans,
        missingWays: mapped.missingWayIds.size,
        skipped: mapped.skipped,
        ineligibleReasons: mapped.ineligibleReasons,
        endingBeforeRenewal: conditions.length - lasting.length,
        withheld,
      });
      if (spans && spanEdgeCache) {
        // An empty set because the FEED is down is not the same as a set with
        // no conditions left: pruning on an outage would throw away every trace
        // and re-trace the lot once OpenConditions returns.
        if (lastConditions) {
          // Keyed on the CURRENT conditions, so a lifted closure's traces leave
          // both the file and this process instead of growing forever — a span
          // key binds the observation id and geometry, so a dropped entry could
          // never be hit again anyway.
          const referenced = new Set(
            conditions.flatMap((c) =>
              c.segments.map((s) =>
                spanKey(c.cacheGeneration ? `${c.cacheGeneration}:${c.id}` : c.id, s),
              ),
            ),
          );
          try {
            await saveSpanEdgeCache(spanEdgeCachePath, spanEdgeCache, referenced);
          } catch (err) {
            log.warn("traffic-live: span cache save failed", { err: (err as Error).message });
          }
          for (const key of spanEdgeCache.keys()) {
            if (!referenced.has(key)) spanEdgeCache.delete(key);
          }
        }
        log.info("traffic-live: span tracing", {
          traced: spans.traced,
          unanswered: spans.unanswered,
          negative: spans.negative,
          skippedBudget: spans.skippedBudget,
          cacheHits: spans.cacheHits,
          edgeExactSpans: mapped.edgeExactSpans,
          wholeWaySpans: mapped.wholeWaySpans,
        });
      }
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
      try {
        await recordTrafficGraphFailure(trafficEvidenceFile, err);
      } catch (evidenceErr) {
        log.warn("traffic-live: evidence failure could not be recorded", {
          err: (evidenceErr as Error).message,
        });
      }
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
          return runTrafficLive().catch((err) => {
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
      const result = await withLegacyDataMutation("traffic-predicted", () =>
        bake({ openConditionsUrl, openConditionsToken, logger: log }),
      );
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
          return runTrafficPredicted().catch((err) => {
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
    void closeTrafficWriter().catch((err) =>
      log.warn("traffic-live: writer shutdown failed", { err }),
    );
    syncCron?.stop();
    feedProxyReloadCron?.stop();
    stalenessCheckCron?.stop();
    overtureCron?.stop();
    overtureConflationRetryCron?.stop();
    trafficExtractCron?.stop();
    trafficLiveCron?.stop();
    if (leaseRenewal) clearTimeout(leaseRenewal);
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
    closeTrafficWriter,
    runSyncNow: runSync,
    runFeedProxyReloadNow: runFeedProxyReload,
    runStalenessCheckNow: runStalenessCheck,
    runOvertureNow: runOvertureSync,
    runOvertureConflationRetryNow: runOvertureConflationRetry,
    runTrafficExtractStartupNow: runTrafficExtractStartup,
    runTrafficExtractGuardNow: runTrafficExtractGuard,
    runWaysToEdgesRefreshNow: runWaysToEdgesRefresh,
    runTrafficLiveNow: runTrafficLive,
    getTrafficConditionsApplied: () =>
      trafficConditionsApplied.validUntil &&
      Date.parse(trafficConditionsApplied.validUntil) > Date.now()
        ? trafficConditionsApplied
        : { ...trafficConditionsApplied, observationIds: [], receipts: [] },
    getPlannedClosures: (bbox, travelAt) => {
      const now = Date.now();
      const conditionsUntil = lastConditions ? lastConditions.fetchedAt + conditionsStaleMs : 0;
      const policyUntil = lastPolicy ? Date.parse(lastPolicy.validUntil) : Number.NaN;
      if (!lastConditions || !lastPolicy || !(conditionsUntil > now) || !(policyUntil > now))
        return null;
      const { closures, unrepresentable } = plannedClosures(lastConditions.conditions, {
        bbox,
        travelAt,
        evaluatedAt: now,
        disallowedSources: new Set(lastPolicy.disallowedSourceIds),
        ...(lastPolicy.rightsPolicy ? { rightsPolicy: lastPolicy.rightsPolicy } : {}),
      });
      const validUntil = Math.min(
        conditionsUntil,
        policyUntil,
        ...closures.map((c) => Date.parse(c.validUntil)),
      );
      return {
        schemaVersion: 1,
        mode: roadConditionsMode,
        evaluatedAt: new Date(now).toISOString(),
        at: new Date(travelAt).toISOString(),
        policyRevision: lastPolicy.revision,
        validUntil: new Date(validUntil).toISOString(),
        closures,
        unrepresentable,
      };
    },
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

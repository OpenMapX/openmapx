import {
  getAllPoiSources,
  type RegisteredPoiSource,
  validatePoiSourceRegistry,
} from "@openmapx/poi-source-registry";
import { Cron } from "croner";
import type { Redis } from "ioredis";
import type { Sql } from "postgres";
import { createLogMetricsSink, type PoiIngestMetricsSink } from "./metrics.js";
import { combineMetricsSinks, createOtelMetricsSink } from "./otel-metrics.js";
import { createPoiJobRow, getLastPoiFeedState } from "./persistence.js";
import { runOneAndPersist } from "./runner.js";
import { createPoiSingleFlight, type PoiSingleFlight } from "./single-flight.js";
import {
  buildPoiGithubIssueSink,
  detectStalePoiSources,
  emitPoiAlerts,
  type PoiGithubIssueSink,
} from "./staleness-alerts.js";
import type { PoiIngestKind, PoiJobLogger } from "./types.js";

/**
 * When no metrics sink is supplied we fan out to both the structured-log sink
 * (free) and the OTEL sink (one in-process counter increment per call). The
 * OTEL pipeline is lazy — `createOtelMetricsSink()` initialises the meter
 * provider on first use, so tests that pass `noopMetricsSink` never touch it.
 */

/** Mirrors the K8s "disable a cron entirely" convention used by `cron.ts`. */
const DISABLED_SENTINELS = new Set(["", "disabled", "off", "false"]);

/**
 * Per-POI-source staleness check cron. Runs daily at 04:30 UTC — 30 minutes
 * after the transitous staleness check so the two warnings don't interleave
 * in centralized logging. Same disable sentinels apply.
 */
const POI_STALENESS_CHECK_CRON_DEFAULT = "30 4 * * *";

export interface PoiSchedulerLogger {
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
}

export interface PoiSchedulerOptions {
  sql: Sql;
  redis: Redis;
  logger: PoiSchedulerLogger;
  /** Defaults to the current registry snapshot (getAllPoiSources()). Override for tests. */
  sources?: readonly RegisteredPoiSource[];
  /** Defaults to createPoiSingleFlight(). */
  singleFlight?: PoiSingleFlight;
  /** Defaults to a structured-log sink. Pass noopMetricsSink for tests. */
  metricsSink?: PoiIngestMetricsSink;
  /**
   * Override the staleness-alert cron expression. Defaults to env var
   * `POI_INGEST_STALENESS_CHECK_CRON` or the daily 04:30 UTC default. Pass
   * a disable sentinel ("disabled", "off", "false", "") to skip wiring.
   */
  stalenessCheckCronExpression?: string;
  /**
   * Test seam: run the staleness check directly instead of going through
   * `detectStalePoiSources` + `emitPoiAlerts`. Production callers omit this.
   */
  runStalenessCheck?: () => Promise<void>;
  /** Test seam: pre-built GitHub sink. Overrides the env-var lookup. */
  githubIssueSink?: PoiGithubIssueSink | null;
}

export interface PoiSchedulerHandles {
  /** All scheduled Cron instances, keyed by `${sourceId}:${kind}`. */
  crons: Map<string, Cron>;
  /** Disabled job keys (env-var sentinel matched). */
  disabled: string[];
  /** Staleness-alert cron — `null` when disabled by env. */
  stalenessCheckCron: Cron | null;
  /** Stop every cron. */
  stop(): void;
  /** Test seam — invoke the handler for one (sourceId, kind) immediately. */
  runNow(sourceId: string, kind: PoiIngestKind): Promise<void>;
  /** Test seam — invoke the staleness check as if the cron fired. */
  runStalenessCheckNow(): Promise<void>;
  /** Process-wide single-flight handle so HTTP routes (B4) can share it. */
  singleFlight: PoiSingleFlight;
  /** Same for the metrics sink. */
  metricsSink: PoiIngestMetricsSink;
}

/**
 * Env-key naming: `POI_INGEST_CRON__BNETZA_EV__STATIC`. Double underscores
 * delimit segments so the source id can contain single underscores in the
 * future (the current ID regex doesn't allow them but kebab-case maps
 * uniquely either way) without colliding with the kind separator.
 */
function envKey(sourceId: string, kind: PoiIngestKind): string {
  return `POI_INGEST_CRON__${sourceId.toUpperCase().replace(/-/g, "_")}__${kind.toUpperCase()}`;
}

function pickCronExpression(source: RegisteredPoiSource, kind: PoiIngestKind): string {
  if (kind === "static") {
    const spec = (source as { static?: { cron: string } }).static;
    if (!spec) throw new Error(`source "${source.id}" has no static spec`);
    return spec.cron;
  }
  if (kind === "live") {
    const spec = (source as { live?: { cron: string } }).live;
    if (!spec) throw new Error(`source "${source.id}" has no live spec`);
    return spec.cron;
  }
  const spec = (source as { bundled?: { cron: string } }).bundled;
  if (!spec) throw new Error(`source "${source.id}" has no bundled spec`);
  return spec.cron;
}

function jobKey(sourceId: string, kind: PoiIngestKind): string {
  return `${sourceId}:${kind}`;
}

/**
 * `PoiSchedulerLogger` and `PoiJobLogger` carry the same (msg, extra) shape;
 * the pipeline-side interface additionally requires `debug` which the
 * scheduler logger doesn't expose. We stub `debug` to `info` so high-volume
 * debug lines from stages are visible during incidents but don't crash if
 * the host logger lacks the method.
 */
function adaptLogger(logger: PoiSchedulerLogger): PoiJobLogger {
  return {
    info: (msg, extra) => logger.info(msg, extra),
    warn: (msg, extra) => logger.warn(msg, extra),
    error: (msg, extra) => logger.error(msg, extra),
    debug: (msg, extra) => logger.info(msg, extra),
  };
}

export function setupPoiIngestCron(opts: PoiSchedulerOptions): PoiSchedulerHandles {
  const sources = opts.sources ?? getAllPoiSources();

  // Boot-time validation: a malformed registry must crash the process loudly
  // rather than silently skip jobs at runtime.
  try {
    validatePoiSourceRegistry(sources);
  } catch (err) {
    opts.logger.error("poi-ingest-cron: registry validation failed", {
      err: (err as Error).message,
    });
    throw err;
  }

  const singleFlight = opts.singleFlight ?? createPoiSingleFlight();
  const jobLogger = adaptLogger(opts.logger);
  const metricsSink =
    opts.metricsSink ??
    combineMetricsSinks(createLogMetricsSink(jobLogger), createOtelMetricsSink());
  const logger = opts.logger;

  const crons = new Map<string, Cron>();
  const disabled: string[] = [];

  async function runOne(
    sourceId: string,
    kind: PoiIngestKind,
    source: RegisteredPoiSource,
  ): Promise<void> {
    const acquire = singleFlight.tryAcquire(sourceId, kind);
    if (!acquire.ok) {
      logger.warn("poi-ingest-cron: skipped scheduled run", {
        sourceId,
        kind,
        reason: acquire.reason,
        existingStartedAt: acquire.existing.startedAt,
      });
      return;
    }

    let jobId: string;
    try {
      jobId = await createPoiJobRow({
        sourceId,
        kind,
        triggeredBy: "cron",
        metadata: { schedule: pickCronExpression(source, kind) },
      });
    } catch (err) {
      // Failing to persist the audit row leaves the lock held; release it
      // explicitly here since runOneAndPersist is never entered.
      singleFlight.release(sourceId, kind);
      logger.error("poi-ingest-cron: createPoiJobRow failed", {
        sourceId,
        kind,
        err: (err as Error).message,
      });
      return;
    }

    // Re-read the previous bundled hash on every fire. The data is one row
    // and the SELECT is cheap; the alternative (caching in-process) would
    // be incorrect across restarts and concurrent manual triggers from B4.
    let previousStaticHash: string | undefined;
    let previousStaticRowCount: number | undefined;
    if (kind === "bundled") {
      const prev = await getLastPoiFeedState(sourceId);
      previousStaticHash = prev?.lastStaticHash ?? undefined;
      previousStaticRowCount = prev?.lastStaticRowCount ?? undefined;
    }

    await runOneAndPersist({
      source,
      kind,
      jobId,
      sql: opts.sql,
      redis: opts.redis,
      singleFlight,
      metricsSink,
      logger: jobLogger,
      triggerLabel: "cron",
      logPrefix: "poi-ingest-cron",
      previousStaticHash,
      previousStaticRowCount,
    });
  }

  // Map of (sourceId, kind) -> source so `runNow` can look up the right source
  // without a linear scan and without trusting the registry to be unchanged
  // by the time a test seam fires.
  const sourceIndex = new Map<string, RegisteredPoiSource>();

  for (const source of sources) {
    const kinds: PoiIngestKind[] = [];
    if ((source as { static?: unknown }).static !== undefined) kinds.push("static");
    if ((source as { live?: unknown }).live !== undefined) kinds.push("live");
    if ((source as { bundled?: unknown }).bundled !== undefined) kinds.push("bundled");

    for (const kind of kinds) {
      const key = jobKey(source.id, kind);
      sourceIndex.set(key, source);
      const expression = pickCronExpression(source, kind);
      const envName = envKey(source.id, kind);
      const raw = process.env[envName];
      if (raw !== undefined && DISABLED_SENTINELS.has(raw.trim().toLowerCase())) {
        disabled.push(key);
        logger.info("poi-ingest-cron: disabled by env", {
          sourceId: source.id,
          kind,
          envName,
        });
        continue;
      }

      const cron = new Cron(
        expression,
        { name: `poi-ingest:${source.id}:${kind}`, protect: true },
        () => {
          void runOne(source.id, kind, source).catch((err) => {
            logger.error("poi-ingest-cron: unexpected runOne rejection", {
              sourceId: source.id,
              kind,
              err: (err as Error).message,
            });
          });
        },
      );
      crons.set(key, cron);
      logger.info("poi-ingest-cron: scheduled", {
        sourceId: source.id,
        kind,
        expression,
      });
    }
  }

  // Summary line is emitted unconditionally — operators rely on it to confirm
  // the scheduler booted at all (referenced by the deployment runbook §6.3).
  logger.info(`poi-ingest-cron: ${crons.size} sources registered, ${disabled.length} disabled`, {
    registered: crons.size,
    disabled: disabled.length,
  });

  // Staleness-alert wiring. Mirrors transitous: the GitHub sink is opt-in via
  // `POI_INGEST_ALERT_GH_TOKEN` + `POI_INGEST_ALERT_GH_REPO`; without those,
  // the structured-log path still fires. The cron itself can be disabled with
  // the standard sentinel set, identical to per-source crons.
  const githubIssueSink: PoiGithubIssueSink | null =
    opts.githubIssueSink !== undefined
      ? opts.githubIssueSink
      : buildPoiGithubIssueSink(
          process.env.POI_INGEST_ALERT_GH_TOKEN?.trim() || undefined,
          process.env.POI_INGEST_ALERT_GH_REPO?.trim() || undefined,
        );

  const defaultStalenessCheck = async (): Promise<void> => {
    const alerts = await detectStalePoiSources();
    if (alerts.length === 0) {
      logger.info("poi-ingest-cron: staleness check found no alerts");
      return;
    }
    await emitPoiAlerts({
      alerts,
      log: jobLogger,
      githubIssue: githubIssueSink ?? undefined,
    });
  };

  const runStalenessCheck = opts.runStalenessCheck ?? defaultStalenessCheck;

  const stalenessExprRaw =
    opts.stalenessCheckCronExpression ??
    process.env.POI_INGEST_STALENESS_CHECK_CRON ??
    POI_STALENESS_CHECK_CRON_DEFAULT;
  const stalenessDisabled = DISABLED_SENTINELS.has(stalenessExprRaw.trim().toLowerCase());
  const stalenessCheckCron: Cron | null = stalenessDisabled
    ? null
    : new Cron(stalenessExprRaw, { name: "poi-ingest:staleness-check", protect: true }, () => {
        void runStalenessCheck().catch((err) => {
          logger.warn("poi-ingest-cron: staleness check threw", {
            err: (err as Error).message,
          });
        });
      });

  if (stalenessDisabled) {
    logger.info("poi-ingest-cron: staleness check disabled by env");
  } else {
    logger.info("poi-ingest-cron: staleness check scheduled", {
      expression: stalenessExprRaw,
      githubIssueSink: githubIssueSink !== null,
    });
  }

  function stop(): void {
    for (const cron of crons.values()) cron.stop();
    stalenessCheckCron?.stop();
  }

  async function runNow(sourceId: string, kind: PoiIngestKind): Promise<void> {
    const source = sourceIndex.get(jobKey(sourceId, kind));
    if (!source) {
      throw new Error(`no scheduled job for "${sourceId}:${kind}"`);
    }
    await runOne(sourceId, kind, source);
  }

  return {
    crons,
    disabled,
    stalenessCheckCron,
    stop,
    runNow,
    runStalenessCheckNow: runStalenessCheck,
    singleFlight,
    metricsSink,
  };
}

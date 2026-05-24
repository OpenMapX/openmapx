import {
  getAllPoiSources,
  type PoiSource,
  validatePoiSourceRegistry,
} from "@openmapx/poi-source-registry";
import { Cron } from "croner";
import type { Redis } from "ioredis";
import type { Sql } from "postgres";
import { createLogMetricsSink, type PoiIngestMetricsSink } from "./metrics.js";
import { createPoiJobRow, getLastPoiFeedState } from "./persistence.js";
import { runOneAndPersist } from "./runner.js";
import { createPoiSingleFlight, type PoiSingleFlight } from "./single-flight.js";
import type { PoiIngestKind, PoiJobLogger } from "./types.js";

/** Mirrors the K8s "disable a cron entirely" convention used by `cron.ts`. */
const DISABLED_SENTINELS = new Set(["", "disabled", "off", "false"]);

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
  sources?: readonly PoiSource[];
  /** Defaults to createPoiSingleFlight(). */
  singleFlight?: PoiSingleFlight;
  /** Defaults to a structured-log sink. Pass noopMetricsSink for tests. */
  metricsSink?: PoiIngestMetricsSink;
}

export interface PoiSchedulerHandles {
  /** All scheduled Cron instances, keyed by `${sourceId}:${kind}`. */
  crons: Map<string, Cron>;
  /** Disabled job keys (env-var sentinel matched). */
  disabled: string[];
  /** Stop every cron. */
  stop(): void;
  /** Test seam — invoke the handler for one (sourceId, kind) immediately. */
  runNow(sourceId: string, kind: PoiIngestKind): Promise<void>;
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

function pickCronExpression(source: PoiSource, kind: PoiIngestKind): string {
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
  const metricsSink = opts.metricsSink ?? createLogMetricsSink(jobLogger);
  const logger = opts.logger;

  const crons = new Map<string, Cron>();
  const disabled: string[] = [];

  async function runOne(sourceId: string, kind: PoiIngestKind, source: PoiSource): Promise<void> {
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
  const sourceIndex = new Map<string, PoiSource>();

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

  function stop(): void {
    for (const cron of crons.values()) cron.stop();
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
    stop,
    runNow,
    singleFlight,
    metricsSink,
  };
}

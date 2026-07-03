import type { PoiSource } from "@openmapx/poi-source-registry";
import type { Redis } from "ioredis";
import type { Sql } from "postgres";
import { withPoiBindings } from "../../logger.js";
import { type PoiIngestMetricsSink, recordRunToSink } from "./metrics.js";
import {
  finalizePoiJobRow,
  makePoiPersistingOnStageComplete,
  upsertPoiFeedState,
} from "./persistence.js";
import {
  buildPoiJobContext,
  runBundledIngest,
  runLiveIngest,
  runStaticIngest,
} from "./pipeline.js";
import type { PoiSingleFlight } from "./single-flight.js";
import type { PoiIngestKind, PoiIngestResult, PoiJobLogger } from "./types.js";

/**
 * The split: the caller (scheduler runOne / api sync route) owns
 * single-flight acquire + `createPoiJobRow`, because both decisions need
 * trigger-specific metadata (cron schedule string vs api idempotency key /
 * triggeredBy label). Everything *after* the job row exists — context build,
 * pipeline dispatch, finalize, upsert, metrics, release — is identical
 * between triggers and lives here.
 */
export interface RunOneOptions {
  source: PoiSource;
  kind: PoiIngestKind;
  jobId: string;
  sql: Sql;
  redis: Redis;
  singleFlight: PoiSingleFlight;
  metricsSink: PoiIngestMetricsSink;
  logger: PoiJobLogger;
  /** "cron" | "api" — drives a log-field annotation only. */
  triggerLabel: string;
  /**
   * Log message prefix — scheduler keeps the historical
   * `poi-ingest-cron:` namespace so existing dashboards / log searches
   * continue to match. The API route uses `poi-ingest-api:`.
   */
  logPrefix: string;
  /** Previous static hash for the bundled change-key short-circuit. */
  previousStaticHash?: string;
  /** Previous static row count paired with previousStaticHash. */
  previousStaticRowCount?: number;
}

function synthesiseErrorResult(sourceId: string, kind: PoiIngestKind, err: Error): PoiIngestResult {
  const ts = new Date().toISOString();
  return {
    sourceId,
    kind,
    startedAt: ts,
    finishedAt: ts,
    durationMs: 0,
    status: "error",
    stages: [],
    error: { message: err.message, stack: err.stack },
  };
}

export async function runOneAndPersist(opts: RunOneOptions): Promise<PoiIngestResult> {
  const {
    source,
    kind,
    jobId,
    sql,
    redis,
    singleFlight,
    metricsSink,
    logger,
    triggerLabel,
    logPrefix,
    previousStaticHash,
    previousStaticRowCount,
  } = opts;
  const sourceId = source.id;
  const runLogger = withPoiBindings(logger, { job: "poi-ingest", sourceId, kind, jobId });

  let result: PoiIngestResult;
  try {
    const ctx = buildPoiJobContext({
      source,
      kind,
      sql,
      redis,
      jobId,
      logger: runLogger,
      lastStaticHash: previousStaticHash,
      onStageComplete: makePoiPersistingOnStageComplete(jobId, runLogger),
    });

    result =
      kind === "static"
        ? await runStaticIngest(ctx)
        : kind === "live"
          ? await runLiveIngest(ctx)
          : await runBundledIngest(ctx);

    // Surface the failing stage + its error message so operators can diagnose
    // without correlating job ids. Successful runs log a thinner line.
    const failedStage = result.stages.find((s) => s.status === "error");
    logger.info(`${logPrefix}: run completed`, {
      sourceId,
      kind,
      jobId,
      trigger: triggerLabel,
      status: result.status,
      durationMs: result.durationMs,
      staticRowCount: result.staticRowCount,
      liveRowCount: result.liveRowCount,
      skippedStaticSwap: result.skippedStaticSwap,
      failedStage: failedStage?.stage,
      err: failedStage?.error?.message ?? result.error?.message,
    });
  } catch (err) {
    logger.error(`${logPrefix}: run threw`, {
      sourceId,
      kind,
      jobId,
      trigger: triggerLabel,
      err: (err as Error).message,
    });
    result = synthesiseErrorResult(sourceId, kind, err as Error);
  } finally {
    // Order matters only in that release() must come last — finalize + upsert
    // + metrics each fail-soft on their own. If any of them threw the lock
    // would still leak; the explicit try/finally protects that invariant.
    // `result` is always assigned by the try-or-catch above (the three
    // runIngest fns either return or throw), so the `!` is a control-flow
    // invariant — TS can't see it across try/catch boundaries.
    try {
      // biome-ignore lint/style/noNonNullAssertion: control-flow invariant
      await finalizePoiJobRow(jobId, result!.status);
    } catch (err) {
      logger.warn(`${logPrefix}: finalizePoiJobRow failed`, {
        sourceId,
        kind,
        jobId,
        err: (err as Error).message,
      });
    }
    try {
      await upsertPoiFeedState({
        sourceId,
        domain: source.domain,
        // biome-ignore lint/style/noNonNullAssertion: control-flow invariant
        result: result!,
        previousStaticHash,
        previousStaticRowCount,
      });
    } catch (err) {
      logger.warn(`${logPrefix}: upsertPoiFeedState failed`, {
        sourceId,
        kind,
        err: (err as Error).message,
      });
    }
    try {
      // biome-ignore lint/style/noNonNullAssertion: control-flow invariant
      recordRunToSink(metricsSink, result!);
    } catch (err) {
      logger.warn(`${logPrefix}: metrics sink threw`, {
        sourceId,
        kind,
        err: (err as Error).message,
      });
    }
    singleFlight.release(sourceId, kind);
  }

  return result;
}

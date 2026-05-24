import { randomUUID } from "node:crypto";
import type { PoiSource } from "@openmapx/poi-source-registry";
import * as fetchStage from "./stages/fetch.js";
import * as parseStage from "./stages/parse.js";
import * as swapStage from "./stages/swap.js";
import * as upsertStaticStage from "./stages/upsert-static.js";
import * as validateStage from "./stages/validate.js";
import * as writeLiveStage from "./stages/write-live.js";
import type {
  PoiIngestKind,
  PoiIngestResult,
  PoiIngestStageName,
  PoiIngestStageResult,
  PoiIngestStageStatus,
  PoiJobContext,
  PoiJobLogger,
  PoiStageFn,
} from "./types.js";

interface PipelineStage {
  name: PoiIngestStageName;
  run: PoiStageFn;
}

const STATIC_STAGES: ReadonlyArray<PipelineStage> = [
  { name: "fetch", run: fetchStage.run },
  { name: "parse", run: parseStage.run },
  { name: "validate", run: validateStage.run },
  { name: "upsert-static", run: upsertStaticStage.run },
  { name: "swap", run: swapStage.run },
];

const LIVE_STAGES: ReadonlyArray<PipelineStage> = [
  { name: "fetch", run: fetchStage.run },
  { name: "parse", run: parseStage.run },
  { name: "write-live", run: writeLiveStage.run },
];

const BUNDLED_STAGES: ReadonlyArray<PipelineStage> = [
  { name: "fetch", run: fetchStage.run },
  { name: "parse", run: parseStage.run },
  { name: "validate", run: validateStage.run },
  { name: "upsert-static", run: upsertStaticStage.run },
  { name: "swap", run: swapStage.run },
  { name: "write-live", run: writeLiveStage.run },
];

function nowIso(ctx: PoiJobContext): string {
  return ctx.now ? ctx.now() : new Date().toISOString();
}

function aggregateStatus(stages: readonly PoiIngestStageResult[]): PoiIngestStageStatus {
  let sawPartial = false;
  let sawNonSkipped = false;
  for (const s of stages) {
    if (s.status === "error") return "error";
    if (s.status === "partial") sawPartial = true;
    if (s.status !== "skipped") sawNonSkipped = true;
  }
  if (sawPartial) return "partial";
  if (!sawNonSkipped) return "skipped";
  return "ok";
}

async function runStages(
  ctx: PoiJobContext,
  stages: ReadonlyArray<PipelineStage>,
): Promise<{ results: PoiIngestStageResult[]; aborted: boolean }> {
  const results: PoiIngestStageResult[] = [];
  let upsertSkipped = false;
  let aborted = false;

  for (const entry of stages) {
    if (ctx.abortSignal.aborted) {
      ctx.logger.warn(`poi-ingest: aborted before ${entry.name}`);
      aborted = true;
      break;
    }

    // The bundled-skip semantics: when upsert-static reports `skipped` (its
    // hash matched the previous run's), the table is unchanged — running
    // swap would rename a stale staging table on top of itself, which would
    // either fail or, worse, silently destroy the live table. So we just
    // skip swap and continue with write-live for bundled sources.
    if (entry.name === "swap" && upsertSkipped) {
      const ts = nowIso(ctx);
      const skipped: PoiIngestStageResult = {
        stage: "swap",
        status: "skipped",
        startedAt: ts,
        finishedAt: ts,
        durationMs: 0,
        message: "static unchanged — skipped",
      };
      results.push(skipped);
      try {
        await ctx.onStageComplete?.(skipped);
      } catch (err) {
        ctx.logger.warn(
          `poi-ingest: onStageComplete threw for swap (skipped): ${(err as Error).message}`,
        );
      }
      continue;
    }

    let result: PoiIngestStageResult;
    try {
      result = await entry.run(ctx);
    } catch (err) {
      // Stage threw despite the per-stage try/catch — this is unexpected.
      // Materialise it as an error result so the pipeline can still abort
      // cleanly and persist a useful row.
      const error = err as Error;
      const ts = nowIso(ctx);
      result = {
        stage: entry.name,
        status: "error",
        startedAt: ts,
        finishedAt: ts,
        durationMs: 0,
        message: error.message,
        error: { message: error.message, stack: error.stack },
      };
    }

    results.push(result);
    try {
      await ctx.onStageComplete?.(result);
    } catch (err) {
      ctx.logger.warn(
        `poi-ingest: onStageComplete threw for ${entry.name}: ${(err as Error).message}`,
      );
    }

    if (result.status === "error") {
      // Halt the pipeline — downstream stages depend on this one's side
      // effects (e.g. swap depends on upsert-static).
      break;
    }
    if (entry.name === "upsert-static" && result.status === "skipped") {
      upsertSkipped = true;
    }
  }

  return { results, aborted };
}

async function runKind(
  ctx: PoiJobContext,
  stages: ReadonlyArray<PipelineStage>,
): Promise<PoiIngestResult> {
  const startedAt = nowIso(ctx);
  const startMs = Date.now();
  let results: PoiIngestStageResult[] = [];
  let aborted = false;
  let topError: { message: string; stack?: string } | undefined;

  try {
    const out = await runStages(ctx, stages);
    results = out.results;
    aborted = out.aborted;
  } catch (err) {
    const error = err as Error;
    const ts = nowIso(ctx);
    // Synthesise a fetch-stage error so the result envelope still has at
    // least one stage row for the persistence layer.
    results.push({
      stage: "fetch",
      status: "error",
      startedAt: ts,
      finishedAt: ts,
      durationMs: 0,
      message: error.message,
      error: { message: error.message, stack: error.stack },
    });
    topError = { message: error.message, stack: error.stack };
  }

  const finishedAt = nowIso(ctx);
  let status = aggregateStatus(results);
  if (aborted && status === "ok") status = "partial";
  if (aborted && results.length === 0) status = "skipped";

  return {
    sourceId: ctx.source.id,
    kind: ctx.kind,
    startedAt,
    finishedAt,
    durationMs: Date.now() - startMs,
    status,
    stages: results,
    staticRowCount: ctx.state.staticRows?.length,
    liveRowCount: ctx.state.liveState?.size,
    staticHash: ctx.state.staticHash,
    skippedStaticSwap: ctx.state.skippedStaticSwap,
    error: topError,
  };
}

export function runStaticIngest(ctx: PoiJobContext): Promise<PoiIngestResult> {
  if (ctx.kind !== "static") {
    return Promise.reject(new Error(`runStaticIngest requires kind="static", got "${ctx.kind}"`));
  }
  return runKind(ctx, STATIC_STAGES);
}

export function runLiveIngest(ctx: PoiJobContext): Promise<PoiIngestResult> {
  if (ctx.kind !== "live") {
    return Promise.reject(new Error(`runLiveIngest requires kind="live", got "${ctx.kind}"`));
  }
  return runKind(ctx, LIVE_STAGES);
}

export function runBundledIngest(ctx: PoiJobContext): Promise<PoiIngestResult> {
  if (ctx.kind !== "bundled") {
    return Promise.reject(new Error(`runBundledIngest requires kind="bundled", got "${ctx.kind}"`));
  }
  return runKind(ctx, BUNDLED_STAGES);
}

export interface BuildPoiJobContextOptions {
  source: PoiSource;
  kind: PoiIngestKind;
  sql: import("postgres").Sql;
  redis: import("ioredis").Redis | null;
  logger?: PoiJobLogger;
  jobId?: string;
  abortSignal?: AbortSignal;
  lastStaticHash?: string;
  onStageComplete?: (r: PoiIngestStageResult) => Promise<void>;
  fetch?: typeof fetch;
  now?: () => string;
}

function defaultLogger(): PoiJobLogger {
  return {
    info: (msg, extra) => console.info(msg, extra ?? {}),
    warn: (msg, extra) => console.warn(msg, extra ?? {}),
    error: (msg, extra) => console.error(msg, extra ?? {}),
    debug: (msg, extra) => console.debug(msg, extra ?? {}),
  };
}

export function buildPoiJobContext(opts: BuildPoiJobContextOptions): PoiJobContext {
  return {
    jobId: opts.jobId ?? randomUUID(),
    source: opts.source,
    kind: opts.kind,
    logger: opts.logger ?? defaultLogger(),
    abortSignal: opts.abortSignal ?? new AbortController().signal,
    onStageComplete: opts.onStageComplete,
    sql: opts.sql,
    redis: opts.redis,
    fetch: opts.fetch,
    now: opts.now,
    lastStaticHash: opts.lastStaticHash,
    state: {},
  };
}

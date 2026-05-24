import type { PoiLiveState, PoiRow, PoiSource } from "@openmapx/poi-source-registry";

export type PoiIngestKind = "static" | "live" | "bundled";

export type PoiIngestStageStatus = "ok" | "skipped" | "error" | "partial";

export type PoiIngestStageName =
  | "fetch"
  | "parse"
  | "validate"
  | "upsert-static"
  | "swap"
  | "write-live";

export interface PoiIngestStageResult {
  stage: PoiIngestStageName;
  status: PoiIngestStageStatus;
  /** ISO 8601 */
  startedAt: string;
  /** ISO 8601 */
  finishedAt: string;
  durationMs: number;
  message?: string;
  error?: { message: string; stack?: string };
  artifacts?: Record<string, unknown>;
}

export interface PoiJobLogger {
  info: (msg: string, extra?: Record<string, unknown>) => void;
  warn: (msg: string, extra?: Record<string, unknown>) => void;
  error: (msg: string, extra?: Record<string, unknown>) => void;
  debug: (msg: string, extra?: Record<string, unknown>) => void;
}

/**
 * Mutable scratch carried between stages. Stages read upstream artifacts from
 * here rather than from `PoiIngestStageResult.artifacts` (which is
 * JSON-serialised for persistence and intentionally small).
 */
export interface PoiJobState {
  fetched?: Buffer;
  staticRows?: PoiRow[];
  liveState?: Map<string, PoiLiveState>;
  staticHash?: string;
  skippedStaticSwap?: boolean;
}

/**
 * Persisted run envelope. The DB upsert into `data_manager.poi_feed_state`
 * is owned by B3 — this layer just returns the structured result.
 */
export interface PoiIngestResult {
  sourceId: string;
  kind: PoiIngestKind;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  status: PoiIngestStageStatus;
  stages: PoiIngestStageResult[];
  staticRowCount?: number;
  liveRowCount?: number;
  staticHash?: string;
  skippedStaticSwap?: boolean;
  /** Top-level error if the pipeline aborted before completing. */
  error?: { message: string; stack?: string };
}

/**
 * Per-run context. The pipeline owns the temporal flow + persistence hook;
 * stages are pure functions of `(source, ctx)`.
 */
export interface PoiJobContext {
  jobId: string;
  source: PoiSource;
  kind: PoiIngestKind;
  logger: PoiJobLogger;
  abortSignal: AbortSignal;
  /** Persisted to `data_manager.job_stages` by B3's onStageComplete hook. */
  onStageComplete?: (result: PoiIngestStageResult) => Promise<void>;
  /** Postgres tag used by upsert-static + swap. */
  sql: import("postgres").Sql;
  /** Redis client used by write-live. `null` = skip live writes (test seam). */
  redis: import("ioredis").Redis | null;
  /** Test seam — replaces global fetch. */
  fetch?: typeof fetch;
  /** Wallclock override for tests. */
  now?: () => string;
  /** Previous static hash for bundled change-key short-circuit. */
  lastStaticHash?: string;
  /** Scratch state shared across stages. */
  state: PoiJobState;
}

export type PoiStageFn = (ctx: PoiJobContext) => Promise<PoiIngestStageResult>;

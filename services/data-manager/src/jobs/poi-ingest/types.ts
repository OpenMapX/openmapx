import type { SafeDownloadOptions, SafeDownloadResult } from "@openmapx/core/utils/safe-download";
import type { PoiLiveState, PoiRow, RegisteredPoiSource } from "@openmapx/poi-source-registry";

export type PoiIngestKind = "static" | "live" | "bundled";

export type PoiIngestStageStatus = "ok" | "skipped" | "error" | "partial";

export type PoiIngestStageName =
  | "fetch"
  | "parse"
  | "validate"
  | "upsert-static"
  | "swap"
  | "write-live";

export type PoiRefreshAttemptOutcome =
  | "running"
  | "succeeded"
  | "unchanged"
  | "partial"
  | "failed"
  | "skipped"
  | "unknown";

/**
 * Durable, stream-specific publication evidence for a POI source.
 *
 * This is intentionally kept separate from the existing timestamp columns on
 * `poi_feed_state`: a static publication and a live cache publication can
 * succeed or fail independently, and a failed attempt must not erase the
 * last known-good publication.
 */
export interface PoiRefreshAttempt {
  at: string | null;
  outcome: PoiRefreshAttemptOutcome;
  jobId: string | null;
  message?: string | null;
}

export interface PoiRefreshStreamEvidence {
  activeVersion: string | null;
  lastSuccessfullyCheckedVersion: string | null;
  lastSuccessfulCheckAt: string | null;
  lastPublishedVersion: string | null;
  lastPublishedAt: string | null;
  rowCount: number | null;
  /** Upstream content timestamp when the source supplies one. */
  upstreamAsOf: string | null;
  /** Earliest/latest upstream timestamp when a snapshot spans a range. */
  upstreamAsOfMin: string | null;
  upstreamAsOfMax: string | null;
  /** Authoritative expiry for live content, when one is known. */
  expiresAt: string | null;
  /** Whether the current stored artifact/cache association is known. */
  activeAssociation: "known" | "unknown" | null;
  /** Non-null only between the durable intent and the verified Redis write. */
  pendingWriteIntentId: string | null;
  lastAttempt: PoiRefreshAttempt;
}

export interface PoiRefreshEvidence {
  version: 1;
  static: PoiRefreshStreamEvidence | null;
  live: PoiRefreshStreamEvidence | null;
}

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
  staticPublicationVersion?: string;
  staticPublishedAt?: string;
  livePublicationVersion?: string;
  livePublishedAt?: string;
}

/** Test/runner seam for the same canonical downloader used in production. */
export type PoiSafeDownloader = (options: SafeDownloadOptions) => Promise<SafeDownloadResult>;

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
  staticPublicationVersion?: string;
  staticPublishedAt?: string;
  livePublicationVersion?: string;
  livePublishedAt?: string;
  /** Top-level error if the pipeline aborted before completing. */
  error?: { message: string; stack?: string };
}

/**
 * Per-run context. The pipeline owns the temporal flow + persistence hook;
 * stages are pure functions of `(source, ctx)`.
 */
export interface PoiJobContext {
  jobId: string;
  source: RegisteredPoiSource;
  kind: PoiIngestKind;
  logger: PoiJobLogger;
  abortSignal: AbortSignal;
  /** Persisted to `data_manager.job_stages` by B3's onStageComplete hook. */
  onStageComplete?: (result: PoiIngestStageResult) => Promise<void>;
  /** Postgres tag used by upsert-static + swap. */
  sql: import("postgres").Sql;
  /** Redis client used by write-live. `null` = skip live writes (test seam). */
  redis: import("ioredis").Redis | null;
  /** Test/runner seam that preserves the production safe-download contract. */
  download?: PoiSafeDownloader;
  /** Wallclock override for tests. */
  now?: () => string;
  /** Previous static hash for bundled change-key short-circuit. */
  lastStaticHash?: string;
  /** Scratch state shared across stages. */
  state: PoiJobState;
}

export type PoiStageFn = (ctx: PoiJobContext) => Promise<PoiIngestStageResult>;

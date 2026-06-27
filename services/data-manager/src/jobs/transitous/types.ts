import type { TransitSource } from "@openmapx/transitous-core";
import type { DatasetMetadata, StateStore } from "../../state.js";
import type { FeedDownloadFailure } from "../download-gtfs.js";

export type { TransitSource };

export type StageStatus = "ok" | "skipped" | "error" | "partial";

export type StageName =
  | "prepare"
  | "filter"
  | "fetch"
  | "validate"
  | "gen-motis-config"
  | "assemble-staging"
  | "motis-import"
  | "motis-health"
  | "gen-full-config"
  | "gen-attribution"
  | "promote"
  | "gc"
  // Mirror mode (TRANSIT_SOURCE=mirror): replaces `fetch` — downloads
  // Transitous's already-cleaned GTFS archives instead of running fetch.py.
  | "mirror";

export interface StageResult {
  stage: StageName;
  status: StageStatus;
  /** ISO 8601 */
  startedAt: string;
  /** ISO 8601 */
  finishedAt: string;
  durationMs: number;
  /** Short human-readable summary. */
  message?: string;
  error?: { message: string; stack?: string };
  /** Small JSON payload (e.g. feed counts). */
  artifacts?: Record<string, unknown>;
}

export type CommandRunner = (
  command: string,
  args: string[],
  opts: { cwd?: string; stdio?: "inherit" | "pipe" },
) => Promise<void>;

export interface JobLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

/**
 * Per-feed entry surfaced by the filter stage and consumed by fetch / gc.
 * Mirrors the shape the legacy monolithic pipeline produced internally
 * (sans the parseFailure marker, which is materialised as a FeedDownloadFailure
 * in the filter stage's artifacts so downstream stages can treat it uniformly).
 */
export interface FeedFileEntry {
  id: string;
  country: string;
  path: string;
  url: string;
  activeScheduleSources: Array<{ id: string; name: string }>;
  parseFailure?: FeedDownloadFailure;
}

/**
 * Mutable scratch carried between stages. Stages read upstream artifacts from
 * here rather than from `StageResult.artifacts` (which is JSON-serialised for
 * persistence). Keep this as small as possible — only what cross-stage
 * coordination genuinely needs.
 */
export interface JobState {
  catalogDir?: string;
  gtfsDir?: string;
  downloadsDir?: string;
  feedFiles?: FeedFileEntry[];
  selectedFeedFiles?: FeedFileEntry[];
  requestedCount?: number;
  selectedCount?: number;
  skippedCount?: number;
  /** Mtime snapshot taken before fetch so partial-success bookkeeping works. */
  preFetchMtimes?: Map<string, number>;
  fetchFailures?: FeedDownloadFailure[];
  /** Set of `<id>` (lowercased) the catalog expects to see on disk. */
  expectedFeedIds?: Set<string>;
  /** Datasets reported to the caller — populated by gc on success / fetch on partial. */
  downloaded?: DatasetMetadata[];
  /** When non-zero some fetches succeeded but others did not. */
  partialSuccess?: boolean;
}

export interface JobContext {
  /** ULID/UUID */
  jobId: string;
  /** Monorepo root (used to resolve lockfile + overlay defaults). */
  repoRoot: string;
  /** Absolute path, typically `infra/docker/data`. */
  dataDir: string;
  /** `<dataDir>/.transitous-catalog` */
  catalogDir: string;
  /** `<dataDir>/.transitous-downloads` */
  downloadsDir: string;
  /** `<dataDir>/gtfs` — also the Transitous build output (`out/` symlinks here). */
  outDir: string;
  /**
   * `<dataDir>/motis/staging` — the dir the `motis-staging` container bind-mounts
   * (plain bind, pipeline-owned). assemble-staging populates it from `outDir`;
   * the container imports in place; promote renames it over {@link motisDataDir}.
   */
  motisStagingDataDir: string;
  /**
   * `<dataDir>/motis/live` — the dir the primary `motis` container bind-mounts
   * (plain bind, pipeline-owned). promote's atomic-swap target.
   */
  motisDataDir: string;
  /** `TRANSITOUS_COUNTRIES` filter, lowercased + deduplicated. */
  countries: string[];
  /** Acquisition mode (default `mirror`). Selects the pipeline's stage list. */
  source: TransitSource;
  /** Mirror-mode: base URL of Transitous's published artifacts. */
  artifactBaseUrl?: string;
  /** Mirror-mode: URL the live MOTIS config's RT feeds are rewritten to (our proxy). */
  feedProxyUrl?: string;
  logger: JobLogger;
  abortSignal: AbortSignal;
  /** Persistence hook — called as each stage completes. */
  onStageComplete: (result: StageResult) => Promise<void>;
  /** Runtime knobs used by the stages but not visible to callers. */
  runner: CommandRunner;
  now: () => string;
  store: StateStore;
  transitousRepoUrl?: string;
  apiKeysPath?: string;
  feedsOverlayPath?: string;
  /** Scratch state passed between stages. */
  state: JobState;
}

export type StageFn = (ctx: JobContext) => Promise<StageResult>;

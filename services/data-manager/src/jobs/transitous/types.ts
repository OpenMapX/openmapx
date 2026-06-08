import type { DatasetMetadata, StateStore } from "../../state.js";
import type { FeedDownloadFailure } from "../download-gtfs.js";

export type StageStatus = "ok" | "skipped" | "error" | "partial";

export type StageName =
  | "prepare"
  | "filter"
  | "fetch"
  | "validate"
  | "gen-motis-config"
  | "motis-import"
  | "motis-health"
  | "gen-full-config"
  | "gen-attribution"
  | "promote"
  | "gc";

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
  /**
   * Path to the generated docker-compose file, as seen inside the data-manager
   * container. When set, `motis-import`'s create fallback runs
   * `docker compose -f <composeFile> up -d motis-staging` instead of relying on
   * a compose file in the process cwd (the prod data-manager's cwd has none).
   * Plumbed from `OPENMAPX_COMPOSE_FILE`; unset in tests/the canary, which keep
   * the cwd-relative behavior.
   */
  composeFile?: string;
  /** `<dataDir>/.transitous-catalog` */
  catalogDir: string;
  /** `<dataDir>/.transitous-downloads` */
  downloadsDir: string;
  /** `<dataDir>/gtfs` */
  outDir: string;
  /** `<dataDir>/motis-staging-data` */
  motisStagingDataDir: string;
  /** `<dataDir>/motis-data` */
  motisDataDir: string;
  /** `TRANSITOUS_COUNTRIES` filter, lowercased + deduplicated. */
  countries: string[];
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

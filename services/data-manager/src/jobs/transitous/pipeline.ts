import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { StateStore } from "../../state.js";
import type { DownloadGtfsResult, FeedDownloadFailure } from "../download-gtfs.js";
import * as fetchStage from "./fetch.js";
import * as filterStage from "./filter.js";
import * as gcStage from "./gc.js";
import * as genAttributionStage from "./gen-attribution.js";
import * as genFullConfigStage from "./gen-full-config.js";
import * as genMotisConfigStage from "./gen-motis-config.js";
import {
  defaultRunner,
  normaliseCountries,
  resetTransitousCatalog,
  TRANSITOUS_CATALOG_DIR,
  TRANSITOUS_DOWNLOADS_DIR,
} from "./internal.js";
import * as motisHealthStage from "./motis-health.js";
import * as motisImportStage from "./motis-import.js";
import * as prepareStage from "./prepare.js";
import * as promoteStage from "./promote.js";
import type {
  CommandRunner,
  JobContext,
  JobLogger,
  StageFn,
  StageName,
  StageResult,
  StageStatus,
} from "./types.js";
import * as validateStage from "./validate.js";

/** Order matters: this is the canonical pipeline ordering for E2. */
const STAGES: ReadonlyArray<{ name: StageName; run: StageFn; hardStop?: boolean }> = [
  { name: "prepare", run: prepareStage.run, hardStop: true },
  { name: "filter", run: filterStage.run, hardStop: true },
  { name: "fetch", run: fetchStage.run },
  { name: "validate", run: validateStage.run },
  { name: "gen-motis-config", run: genMotisConfigStage.run },
  { name: "motis-import", run: motisImportStage.run },
  { name: "motis-health", run: motisHealthStage.run },
  { name: "gen-full-config", run: genFullConfigStage.run },
  { name: "gen-attribution", run: genAttributionStage.run },
  { name: "promote", run: promoteStage.run },
  { name: "gc", run: gcStage.run },
];

export interface RunPipelineOptions {
  startAt?: StageName;
  stopAt?: StageName;
}

export interface RunPipelineResult {
  jobId: string;
  results: StageResult[];
  finalStatus: StageStatus;
}

/**
 * Run the staged Transitous pipeline.
 *
 * - Stages 1-11 run in order; each result is persisted via `ctx.onStageComplete`.
 * - If a `hardStop` stage (prepare, filter) returns `status: "error"`, the
 *   underlying Error is rethrown after the catalog is reset. Soft-stop stages
 *   record their error in the result list and the pipeline continues.
 * - `motis-import` / `motis-health` / `promote` exec against the staging MOTIS
 *   container and only swap data dirs after smoke probes pass. They return
 *   `"skipped"` when the staging dir / config / container isn't available
 *   (typical for unit tests and dev environments).
 * - The final status aggregates as: `"error"` if any non-skipped stage errored;
 *   `"partial"` if any stage returned `"partial"`; `"ok"` otherwise.
 */
export async function runTransitousPipeline(
  ctx: JobContext,
  options: RunPipelineOptions = {},
): Promise<RunPipelineResult> {
  const results: StageResult[] = [];
  const startIdx = options.startAt ? STAGES.findIndex((s) => s.name === options.startAt) : 0;
  const stopIdx = options.stopAt
    ? STAGES.findIndex((s) => s.name === options.stopAt)
    : STAGES.length - 1;
  if (startIdx < 0) throw new Error(`Unknown startAt stage: ${options.startAt}`);
  if (stopIdx < 0) throw new Error(`Unknown stopAt stage: ${options.stopAt}`);

  let hardStopError: Error | undefined;
  try {
    for (let i = startIdx; i <= stopIdx; i++) {
      const entry = STAGES[i];
      if (!entry) continue;
      if (ctx.abortSignal.aborted) {
        ctx.logger.warn(`transitous-pipeline: aborted before ${entry.name}`);
        break;
      }
      const result = await entry.run(ctx);
      results.push(result);
      try {
        await ctx.onStageComplete(result);
      } catch (err) {
        ctx.logger.warn(
          `transitous-pipeline: onStageComplete threw for ${entry.name}: ${(err as Error).message}`,
        );
      }
      if (result.status === "error" && entry.hardStop) {
        hardStopError = new Error(
          result.error?.message ?? result.message ?? `${entry.name} failed`,
        );
        if (result.error?.stack) hardStopError.stack = result.error.stack;
        break;
      }
    }
  } finally {
    try {
      const catalogDir = ctx.state.catalogDir ?? ctx.catalogDir;
      await resetTransitousCatalog(catalogDir, ctx.runner);
    } catch {
      // Best effort only.
    }
  }

  if (hardStopError) throw hardStopError;

  return {
    jobId: ctx.jobId,
    results,
    finalStatus: aggregateFinalStatus(results),
  };
}

function aggregateFinalStatus(results: StageResult[]): StageStatus {
  let sawPartial = false;
  for (const result of results) {
    if (result.status === "error") return "error";
    if (result.status === "partial") sawPartial = true;
  }
  return sawPartial ? "partial" : "ok";
}

export interface BuildJobContextOptions {
  dataDir: string;
  store: StateStore;
  countries?: string[];
  repoRoot?: string;
  transitousRepoUrl?: string;
  apiKeysPath?: string;
  feedsOverlayPath?: string;
  runner?: CommandRunner;
  now?: () => string;
  logger?: JobLogger;
  abortSignal?: AbortSignal;
  onStageComplete?: (result: StageResult) => Promise<void>;
  jobId?: string;
}

/** Build a `JobContext` with safe defaults; used by API + tests. */
export function buildJobContext(opts: BuildJobContextOptions): JobContext {
  const logger: JobLogger = opts.logger ?? wrapConsoleLogger();
  const catalogDir = join(opts.dataDir, TRANSITOUS_CATALOG_DIR);
  const downloadsDir = join(opts.dataDir, TRANSITOUS_DOWNLOADS_DIR);
  const outDir = join(opts.dataDir, "gtfs");
  return {
    jobId: opts.jobId ?? randomUUID(),
    repoRoot: opts.repoRoot ?? "",
    dataDir: opts.dataDir,
    catalogDir,
    downloadsDir,
    outDir,
    motisStagingDataDir: join(opts.dataDir, "motis-staging-data"),
    motisDataDir: join(opts.dataDir, "motis-data"),
    countries: normaliseCountries(opts.countries ?? []),
    logger,
    abortSignal: opts.abortSignal ?? new AbortController().signal,
    onStageComplete: opts.onStageComplete ?? (async () => {}),
    runner: opts.runner ?? defaultRunner,
    now: opts.now ?? (() => new Date().toISOString()),
    store: opts.store,
    transitousRepoUrl: opts.transitousRepoUrl,
    apiKeysPath: opts.apiKeysPath,
    feedsOverlayPath: opts.feedsOverlayPath,
    state: {},
  };
}

function wrapConsoleLogger(): JobLogger {
  return {
    info: (msg) => console.info(msg),
    warn: (msg) => console.warn(msg),
    error: (msg) => console.error(msg),
  };
}

/**
 * Materialise the legacy `DownloadGtfsResult` shape from a completed pipeline
 * run so existing callers (data-manager `/download/gtfs` route, CLI helpers)
 * stay backward-compatible with the response payload they emit.
 */
export function toDownloadGtfsResult(ctx: JobContext, _results: StageResult[]): DownloadGtfsResult {
  const requestedCount = ctx.state.requestedCount ?? 0;
  const selectedCount = ctx.state.selectedCount ?? 0;
  const skippedCount = ctx.state.skippedCount ?? 0;
  const downloaded = ctx.state.downloaded ?? [];
  const failures = (ctx.state.fetchFailures ?? []) as FeedDownloadFailure[];
  return {
    requestedCount,
    selectedCount,
    skippedCount,
    downloaded,
    failures,
    partialSuccess: ctx.state.partialSuccess === true,
  };
}

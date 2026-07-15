import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { asJobLogger, jobChildLogger } from "../../logger.js";
import type { StateStore } from "../../state.js";
import type { DownloadGtfsResult, FeedDownloadFailure } from "../download-gtfs.js";
import * as assembleStagingStage from "./assemble-staging.js";
import * as fetchStage from "./fetch.js";
import * as filterStage from "./filter.js";
import * as gcStage from "./gc.js";
import * as genAttributionStage from "./gen-attribution.js";
import * as genFullConfigStage from "./gen-full-config.js";
import {
  defaultRunner,
  normaliseCountries,
  resetTransitousCatalog,
  TRANSITOUS_CATALOG_DIR,
  TRANSITOUS_DOWNLOADS_DIR,
} from "./internal.js";
import * as mirrorStage from "./mirror.js";
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
  TransitSource,
} from "./types.js";
import * as validateStage from "./validate.js";

export type StageCriticality = "critical" | "advisory";
type StageEntry = { name: StageName; run: StageFn; criticality: StageCriticality };

/** Build mode (TRANSIT_SOURCE=build): clone the catalog + run Transitous scripts. */
const BUILD_STAGES: ReadonlyArray<StageEntry> = [
  { name: "prepare", run: prepareStage.run, criticality: "critical" },
  { name: "filter", run: filterStage.run, criticality: "critical" },
  // Acquisition may report individual failures while preserving known-good
  // archives from the previous run. Assembly remains the authoritative empty
  // or incomplete candidate boundary.
  { name: "fetch", run: fetchStage.run, criticality: "advisory" },
  { name: "validate", run: validateStage.run, criticality: "critical" },
  // Generate the one final runtime config and attribution before assembly.
  // The exact candidate imported and probed is therefore the tuple promoted.
  { name: "gen-full-config", run: genFullConfigStage.run, criticality: "critical" },
  { name: "gen-attribution", run: genAttributionStage.run, criticality: "critical" },
  // critical: assemble-staging returns "error" when it would stage 0 feeds.
  // That's the real empty-import guard — halt before the container import +
  // promote so a total acquisition failure can't swap an empty timetable over
  // the live one. (fetch/mirror can legitimately "error" while a stale archive
  // from a prior run is preserved on disk; that archive still gets assembled,
  // so the guard belongs here, on the staged count — not on the fetch result.)
  { name: "assemble-staging", run: assembleStagingStage.run, criticality: "critical" },
  { name: "motis-import", run: motisImportStage.run, criticality: "critical" },
  { name: "motis-health", run: motisHealthStage.run, criticality: "critical" },
  { name: "promote", run: promoteStage.run, criticality: "critical" },
  { name: "gc", run: gcStage.run, criticality: "advisory" },
];

/**
 * Mirror mode (TRANSIT_SOURCE=mirror, default): identical to build mode except
 * the `fetch` stage is replaced by `mirror`, which downloads Transitous's
 * already-cleaned GTFS archives instead of running fetch.py + gtfsclean. The
 * MOTIS config, attribution, and feed-proxy are still generated from the
 * catalog clone, so the result matches build mode (incl. RT routed through our
 * own feed-proxy) — only the slow/fragile fetch step is skipped.
 */
const MIRROR_STAGES: ReadonlyArray<StageEntry> = BUILD_STAGES.map((stage) =>
  stage.name === "fetch"
    ? { name: "mirror", run: mirrorStage.run, criticality: stage.criticality }
    : stage,
);

export function stagesFor(source: TransitSource): ReadonlyArray<StageEntry> {
  return source === "mirror" ? MIRROR_STAGES : BUILD_STAGES;
}

export function stagePolicyFor(source: TransitSource): ReadonlyArray<{
  name: StageName;
  criticality: StageCriticality;
}> {
  return stagesFor(source).map(({ name, criticality }) => ({ name, criticality }));
}

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
 * - If a critical stage returns `status: "error"`, the
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
  const stages = stagesFor(ctx.source);
  const startIdx = options.startAt ? stages.findIndex((s) => s.name === options.startAt) : 0;
  const stopIdx = options.stopAt
    ? stages.findIndex((s) => s.name === options.stopAt)
    : stages.length - 1;
  if (startIdx < 0) throw new Error(`Unknown startAt stage: ${options.startAt}`);
  if (stopIdx < 0) throw new Error(`Unknown stopAt stage: ${options.stopAt}`);

  let hardStopError: Error | undefined;
  try {
    for (let i = startIdx; i <= stopIdx; i++) {
      const entry = stages[i];
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
      if (result.status === "error" && entry.criticality === "critical") {
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
  /** Acquisition mode. Defaults to `build` (callers pass the operator setting). */
  source?: TransitSource;
  artifactBaseUrl?: string;
  feedProxyUrl?: string;
  /** Mirror-mode archive downloader (default: curlAtomic). Injected by tests. */
  artifactDownloader?: (url: string, dest: string) => Promise<void>;
}

/** Build a `JobContext` with safe defaults; used by API + tests. */
export function buildJobContext(opts: BuildJobContextOptions): JobContext {
  const logger: JobLogger =
    opts.logger ?? asJobLogger(jobChildLogger({ job: "transitous", jobId: opts.jobId }));
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
    motisStagingDataDir: join(opts.dataDir, "motis", "staging"),
    motisDataDir: join(opts.dataDir, "motis", "live"),
    countries: normaliseCountries(opts.countries ?? []),
    source: opts.source ?? "build",
    artifactBaseUrl: opts.artifactBaseUrl,
    feedProxyUrl: opts.feedProxyUrl,
    artifactDownloader: opts.artifactDownloader,
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

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { asJobLogger, jobChildLogger } from "../../logger.js";
import type { StateStore } from "../../state.js";
import * as assembleStagingStage from "./assemble-staging.js";
import * as compileGbfsStage from "./compile-gbfs.js";
import * as fetchStage from "./fetch.js";
import * as fetchOperatorStage from "./fetch-operator.js";
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
import { type MotisOperationsPolicy, resolveOperationsProfile } from "./operations-profile.js";
import { getOperatorFeedRelayStore, type OperatorFeedRelayStore } from "./operator-feed-relay.js";
import * as preflightStage from "./preflight.js";
import * as prepareStage from "./prepare.js";
import * as promoteStage from "./promote.js";
import * as proxyTransactionStage from "./proxy-transaction.js";
import {
  createDefaultTransitousScriptRunner,
  type TransitousScriptRunner,
} from "./script-runner.js";
import { ensureMotisSlotLayout } from "./slot-state.js";
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
  { name: "preflight", run: preflightStage.run, criticality: "critical" },
  { name: "compile-gbfs", run: compileGbfsStage.run, criticality: "critical" },
  // A missing desired schedule source is fatal. Cached archives remain on disk
  // for retry efficiency but are never used to turn this attempt into a
  // reduced or ambiguously partial candidate.
  { name: "fetch", run: fetchStage.run, criticality: "critical" },
  { name: "validate", run: validateStage.run, criticality: "critical" },
  // Generate the one final runtime config and attribution before assembly.
  // The exact candidate imported and probed is therefore the tuple promoted.
  { name: "gen-full-config", run: genFullConfigStage.run, criticality: "critical" },
  { name: "gen-attribution", run: genAttributionStage.run, criticality: "critical" },
  // Assembly independently verifies that the complete, hashed source manifest
  // and its referenced datasets enter the exact candidate that is imported.
  { name: "assemble-staging", run: assembleStagingStage.run, criticality: "critical" },
  { name: "stage-proxy", run: proxyTransactionStage.run, criticality: "critical" },
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
const MIRROR_STAGES: ReadonlyArray<StageEntry> = BUILD_STAGES.flatMap((stage) =>
  stage.name === "fetch"
    ? [
        { name: "mirror", run: mirrorStage.run, criticality: "critical" },
        { name: "fetch-operator", run: fetchOperatorStage.run, criticality: "critical" },
      ]
    : [stage],
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
    if (hardStopError) {
      try {
        await proxyTransactionStage.rollbackProxyTransaction(ctx);
      } catch (error) {
        ctx.logger.error(
          `transitous-pipeline: feed-proxy rollback failed: ${(error as Error).message}`,
        );
        hardStopError = new Error(
          `${hardStopError.message}; feed-proxy rollback also failed: ${(error as Error).message}`,
        );
      }
    }
    try {
      const catalogDir = ctx.state.catalogDir ?? ctx.catalogDir;
      await resetTransitousCatalog(catalogDir, ctx.runner);
    } catch {
      // Best effort only.
    }
    try {
      await ctx.operatorFeedRelay.endRun(ctx.jobId);
    } catch (error) {
      ctx.logger.error(
        `transitous-pipeline: operator feed relay cleanup failed: ${(error as Error).message}`,
      );
      const cleanupError = new Error("Operator feed relay cleanup failed");
      hardStopError = hardStopError
        ? new Error(`${hardStopError.message}; ${cleanupError.message}`)
        : cleanupError;
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
  operatorFeedRelay?: OperatorFeedRelayStore;
  runner?: CommandRunner;
  runScript?: TransitousScriptRunner;
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
  operationsPolicy?: MotisOperationsPolicy;
  operationsProfile?: string;
  feedAllowList?: string[];
  confirmPlanet?: boolean;
  osmInput?: string;
  /** Build from the proposed lock (auto-bump canary) instead of the active one. */
  useProposedLock?: boolean;
}

/** Build a `JobContext` with safe defaults; used by API + tests. */
export function buildJobContext(opts: BuildJobContextOptions): JobContext {
  const logger: JobLogger =
    opts.logger ?? asJobLogger(jobChildLogger({ job: "transitous", jobId: opts.jobId }));
  const catalogDir = join(opts.dataDir, TRANSITOUS_CATALOG_DIR);
  const downloadsDir = join(opts.dataDir, TRANSITOUS_DOWNLOADS_DIR);
  const outDir = join(opts.dataDir, "gtfs");
  const countries = normaliseCountries(opts.countries ?? []);
  const source = opts.source ?? "build";
  const operationsPolicy =
    opts.operationsPolicy ??
    resolveOperationsProfile({
      profile: opts.operationsProfile,
      countries,
      feedAllowList: opts.feedAllowList,
      source,
      artifactBaseUrl: opts.artifactBaseUrl,
      confirmPlanet: opts.confirmPlanet,
      osmInput: opts.osmInput,
      // Direct stage tests historically construct an empty-scope context.
      // The mandatory pipeline preflight remains the enforcement boundary.
      allowEmptyRegional: true,
    });
  const slotLayout =
    process.env.MOTIS_TWO_SLOT === "true" ? ensureMotisSlotLayout(opts.dataDir) : undefined;
  return {
    jobId: opts.jobId ?? randomUUID(),
    repoRoot: opts.repoRoot ?? "",
    dataDir: opts.dataDir,
    catalogDir,
    downloadsDir,
    outDir,
    motisStagingDataDir: join(opts.dataDir, "motis", "staging"),
    motisDataDir: join(opts.dataDir, "motis", "live"),
    countries,
    source,
    operationsPolicy,
    slotLayout,
    artifactBaseUrl: opts.artifactBaseUrl,
    feedProxyUrl: opts.feedProxyUrl,
    artifactDownloader: opts.artifactDownloader,
    logger,
    abortSignal: opts.abortSignal ?? new AbortController().signal,
    onStageComplete: opts.onStageComplete ?? (async () => {}),
    runner: opts.runner ?? defaultRunner,
    runScript: opts.runScript ?? createDefaultTransitousScriptRunner(),
    now: opts.now ?? (() => new Date().toISOString()),
    store: opts.store,
    transitousRepoUrl: opts.transitousRepoUrl,
    apiKeysPath: opts.apiKeysPath,
    feedsOverlayPath: opts.feedsOverlayPath,
    operatorFeedRelay: opts.operatorFeedRelay ?? getOperatorFeedRelayStore(),
    useProposedLock: opts.useProposedLock,
    state: {},
  };
}

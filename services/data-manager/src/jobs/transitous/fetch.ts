import { statSync } from "node:fs";
import { feedKeyForSource, recordFetchOutcome } from "./feed-state-writer.js";
import { runFetchPipeline, scanGtfsArchives } from "./internal.js";
import { finalizeTransitSourceManifest } from "./source-manifest.js";
import type {
  FeedDownloadFailure,
  FeedFileEntry,
  JobContext,
  StageFn,
  StageResult,
  StageStatus,
} from "./types.js";

/**
 * Run Transitous's `src/fetch.py` for every selected feed file. Captures
 * per-feed failures and snapshots pre-fetch mtimes so failure
 * bookkeeping can identify which archives were freshly written. The status
 * is `"ok"` only if every desired source succeeded. Any missing desired
 * source makes the candidate incomplete and therefore returns `"error"`.
 */
export const run: StageFn = async (ctx) => {
  const startedAt = ctx.now();
  const start = Date.now();
  try {
    const catalogDir = ctx.state.catalogDir ?? ctx.catalogDir;
    const gtfsDir = ctx.state.gtfsDir ?? ctx.outDir;
    const selectedFeedFiles = ctx.state.selectedFeedFiles ?? [];

    // Snapshot the mtime of every existing archive so that, on a partial
    // failure, we can tell which entries fetch.py actually rewrote during
    // this run versus archives left over from a previous run.
    const preFetchMtimes = new Map<string, number>();
    for (const archive of scanGtfsArchives(gtfsDir)) {
      try {
        preFetchMtimes.set(archive.path, statSync(archive.path).mtimeMs);
      } catch {
        // Best effort.
      }
    }
    ctx.state.preFetchMtimes = preFetchMtimes;

    const parseFailures: FeedDownloadFailure[] = selectedFeedFiles.flatMap((feed) =>
      feed.parseFailure ? [feed.parseFailure] : [],
    );
    const runnableFeedFiles = selectedFeedFiles.filter((feed) => !feed.parseFailure);

    const fetchFailures = await runFetchPipeline(
      catalogDir,
      runnableFeedFiles,
      ctx.runner,
      ctx.logger,
    );
    const failures: FeedDownloadFailure[] = [...parseFailures, ...fetchFailures];
    ctx.state.fetchFailures = failures;

    // Persist per-feed fetch outcomes so the staleness-alert cron (G2) sees
    // which feeds successfully refreshed and which failed. Best-effort: a DB
    // outage here is logged at warn level and otherwise non-fatal.
    await persistFetchOutcomes(selectedFeedFiles, failures, ctx);

    if (failures.length === 0) finalizeTransitSourceManifest(ctx);

    // A feed file with N active schedule sources may surface 1..N failures
    // attributable to specific sources. We treat the stage as fully failed
    // when every selected source failed, partial when only some did.
    const selectedCount = ctx.state.selectedCount ?? 0;
    const fetchedCount = Math.max(0, selectedCount - failures.length);
    const status: StageStatus = failures.length > 0 ? "error" : "ok";

    const finishedAt = ctx.now();
    return {
      stage: "fetch",
      status,
      startedAt,
      finishedAt,
      durationMs: Date.now() - start,
      message:
        failures.length === 0
          ? `Fetched ${selectedCount} feed source(s)`
          : `Fetched ${fetchedCount}/${selectedCount} feed source(s); ${failures.length} failure(s)`,
      artifacts: {
        fetched: fetchedCount,
        failed: failures,
      },
    } satisfies StageResult;
  } catch (error) {
    const err = error as Error;
    return {
      stage: "fetch",
      status: "error",
      startedAt,
      finishedAt: ctx.now(),
      durationMs: Date.now() - start,
      message: err.message,
      error: { message: err.message, stack: err.stack },
    };
  }
};

export type { JobContext };

/**
 * Push per-feed fetch outcomes into `data_manager.feed_state`. Each selected
 * source generates one row; if a `FeedDownloadFailure` referenced the source
 * the outcome is `ok: false`, otherwise `ok: true`. DB errors are logged but
 * do not propagate (they would otherwise mask the genuine fetch result).
 */
async function persistFetchOutcomes(
  selectedFeedFiles: FeedFileEntry[],
  failures: FeedDownloadFailure[],
  ctx: JobContext,
): Promise<void> {
  // Match failures on the synthesized source id — the (region, name) natural
  // key diverges from it for subdivision regions and sanitized names, which
  // would record a failed source as fetched.
  const failedIds = new Set(failures.map((failure) => failure.id.toLowerCase()));
  for (const feed of selectedFeedFiles) {
    for (const source of feed.activeScheduleSources) {
      const key = feedKeyForSource(feed, source.name, source.region);
      const fingerprint = `${key.region}::${key.name}`;
      const ok = !failedIds.has(source.id.toLowerCase());
      try {
        await recordFetchOutcome({ region: key.region, name: key.name, ok });
      } catch (err) {
        ctx.logger.warn(
          `transitous-fetch: feed_state write failed for ${fingerprint}: ${(err as Error).message}`,
        );
      }
    }
  }
}

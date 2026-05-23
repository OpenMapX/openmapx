import { statSync } from "node:fs";
import type { FeedDownloadFailure } from "../download-gtfs.js";
import { feedKeyForFailure, feedKeyForSource, recordFetchOutcome } from "./feed-state-writer.js";
import { runFetchPipeline, scanGtfsArchives } from "./internal.js";
import type { FeedFileEntry, JobContext, StageFn, StageResult, StageStatus } from "./types.js";

/**
 * Run Transitous's `src/fetch.py` for every selected feed file. Captures
 * per-feed failures and snapshots pre-fetch mtimes so partial-success
 * bookkeeping can identify which archives were freshly written. The status
 * is `"ok"` if all fetches succeeded, `"partial"` if some did and some
 * failed, and `"error"` if every fetch failed.
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

    // A feed file with N active schedule sources may surface 1..N failures
    // attributable to specific sources. We treat the stage as fully failed
    // when every selected source failed, partial when only some did.
    const selectedCount = ctx.state.selectedCount ?? 0;
    const fetchedCount = Math.max(0, selectedCount - failures.length);
    let status: StageStatus = "ok";
    if (failures.length > 0) {
      status = fetchedCount === 0 ? "error" : "partial";
    }

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
  const failedKeys = new Set(
    failures.map((failure) => {
      const key = feedKeyForFailure(failure);
      return `${key.region}::${key.name}`;
    }),
  );
  for (const feed of selectedFeedFiles) {
    for (const source of feed.activeScheduleSources) {
      const key = feedKeyForSource(feed, source.name);
      const fingerprint = `${key.region}::${key.name}`;
      const ok = !failedKeys.has(fingerprint);
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

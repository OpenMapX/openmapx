import { statSync } from "node:fs";
import type { DatasetMetadata } from "../../state.js";
import type { GtfsArchiveSnapshot } from "./internal.js";
import {
  garbageCollectTransitousOutputs,
  pruneFeedsNotInCatalog,
  pruneFeedsOutsideCountryFilter,
  scanGtfsArchives,
} from "./internal.js";
import type { StageFn, StageResult } from "./types.js";

/**
 * Post-fetch housekeeping. On a fully successful fetch we run Transitous's
 * `garbage-collect.py`, prune any GTFS archives the catalog no longer lists
 * (or that fall outside the country filter), and replace the GTFS portion of
 * the dataset registry wholesale. On partial / total failure we leave every
 * existing archive in place so the next run can resume; only archives whose
 * mtime advanced during this run are upserted into the store.
 */
export const run: StageFn = async (ctx) => {
  const startedAt = ctx.now();
  const start = Date.now();
  try {
    const catalogDir = ctx.state.catalogDir ?? ctx.catalogDir;
    const gtfsDir = ctx.state.gtfsDir ?? ctx.outDir;
    const failures = ctx.state.fetchFailures ?? [];
    const expectedFeedIds = ctx.state.expectedFeedIds ?? new Set<string>();
    const preFetchMtimes = ctx.state.preFetchMtimes ?? new Map<string, number>();
    const refreshedAt = ctx.now();

    let removed = 0;
    let downloaded: DatasetMetadata[] = [];

    if (failures.length === 0) {
      const before = scanGtfsArchives(gtfsDir).map((archive) => archive.path);
      await garbageCollectTransitousOutputs(catalogDir, ctx.runScript);
      pruneFeedsNotInCatalog(gtfsDir, ctx.countries, expectedFeedIds);
      pruneFeedsOutsideCountryFilter(gtfsDir, ctx.countries);

      const after = scanGtfsArchives(gtfsDir);
      const afterPaths = new Set(after.map((archive) => archive.path));
      removed = before.filter((path) => !afterPaths.has(path)).length;

      downloaded = after.map((archive) => toDatasetMetadata(archive, refreshedAt));
      ctx.store.replaceType("gtfs", downloaded);
      ctx.state.downloaded = downloaded;
      ctx.state.partialSuccess = false;
    } else {
      const currentArchives = scanGtfsArchives(gtfsDir);
      const freshlyWritten = currentArchives.filter((archive) => {
        let mtimeMs: number;
        try {
          mtimeMs = statSync(archive.path).mtimeMs;
        } catch {
          return false;
        }
        const previous = preFetchMtimes.get(archive.path);
        return previous === undefined || mtimeMs > previous;
      });
      downloaded = freshlyWritten.map((archive) => toDatasetMetadata(archive, refreshedAt));
      for (const dataset of downloaded) {
        ctx.store.upsert(dataset);
      }
      ctx.state.downloaded = downloaded;
      ctx.state.partialSuccess = downloaded.length > 0 && failures.length > 0;
    }

    return {
      stage: "gc",
      status: "ok",
      startedAt,
      finishedAt: ctx.now(),
      durationMs: Date.now() - start,
      message:
        failures.length === 0
          ? `Garbage-collected ${removed} stale archive(s); dataset store synchronised`
          : `Skipped pruning due to fetch failures; upserted ${downloaded.length} fresh archive(s)`,
      artifacts: {
        removed,
        downloaded: downloaded.length,
        partialSuccess: ctx.state.partialSuccess === true,
      },
    } satisfies StageResult;
  } catch (error) {
    const err = error as Error;
    return {
      stage: "gc",
      status: "error",
      startedAt,
      finishedAt: ctx.now(),
      durationMs: Date.now() - start,
      message: err.message,
      error: { message: err.message, stack: err.stack },
    };
  }
};

function toDatasetMetadata(archive: GtfsArchiveSnapshot, downloadedAt: string): DatasetMetadata {
  return {
    type: "gtfs",
    id: archive.id,
    sizeBytes: archive.sizeBytes,
    downloadedAt,
    path: archive.path,
  };
}

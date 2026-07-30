import { mkdirSync } from "node:fs";
import {
  type MirrorArchive,
  mirrorArchives,
  TRANSITOUS_ARTIFACT_BASE_URL,
} from "@openmapx/transitous-core";
import { curlAtomic } from "../atomic-download.js";
import type { FeedDownloadFailure } from "../download-gtfs.js";
import { feedKeyForSource, recordFetchOutcome } from "./feed-state-writer.js";
import type { StageFn, StageResult, StageStatus } from "./types.js";

/**
 * Mirror-mode replacement for the `fetch` stage. Instead of running fetch.py
 * (download each origin feed + gtfsclean — the slow, fragile step), download
 * Transitous's already-cleaned `*.gtfs.zip` / `*.netex.zip` artifacts from its
 * published output. Everything downstream (validate, gen-motis-config,
 * gen-full-config, gen-attribution, assemble, import, promote) is identical to
 * build mode and runs against the catalog clone + the mirrored archives.
 *
 * The download itself is the shared `mirrorArchives` (direct per-archive by URL,
 * concurrent, gtfs→netex probe) — deterministic and incremental (curlAtomic
 * sends If-Modified-Since for archives already on disk), unlike a recursive wget
 * that has to parse the multi-thousand-entry autoindex and silently fetched
 * nothing. `feed_state` records this attempt's result. A missing desired source
 * is fatal even when an older archive remains in the cache, so a transient
 * failure cannot silently alter the promoted source set.
 */
export const run: StageFn = async (ctx): Promise<StageResult> => {
  const startedAt = ctx.now();
  const start = Date.now();
  try {
    const gtfsDir = ctx.state.gtfsDir ?? ctx.outDir;
    mkdirSync(gtfsDir, { recursive: true });
    // `||` (not `??`): compose injects `${VAR:-}` as an empty string when the
    // operator hasn't set it, and "" must fall through to the default.
    const baseUrl =
      ctx.artifactBaseUrl ||
      process.env.TRANSITOUS_ARTIFACT_BASE_URL ||
      TRANSITOUS_ARTIFACT_BASE_URL;
    const download = ctx.artifactDownloader ?? curlAtomic;
    const selectedFeedFiles = ctx.state.selectedFeedFiles ?? [];

    // Download every selected source's archive concurrently via the shared
    // core helper. We re-derive per-source outcome from disk below, so the
    // returned counts are advisory here.
    const archives: MirrorArchive[] = selectedFeedFiles.flatMap((feed) =>
      feed.activeScheduleSources
        .filter((source) => source.origin === "catalog")
        .map((source) => ({ region: feed.id, name: source.name })),
    );
    const mirrorResult = await mirrorArchives({
      archives,
      baseUrl,
      destDir: gtfsDir,
      download,
      logger: ctx.logger,
    });
    const missing = new Set(
      mirrorResult.missing.map((entry) => `${entry.region}\u0000${entry.name}`),
    );

    const failures: FeedDownloadFailure[] = [];
    for (const feed of selectedFeedFiles) {
      for (const source of feed.activeScheduleSources.filter(
        (candidate) => candidate.origin === "catalog",
      )) {
        const present = !missing.has(`${feed.id}\u0000${source.name}`);
        const key = feedKeyForSource(feed, source.name, source.region);
        try {
          await recordFetchOutcome({ region: key.region, name: key.name, ok: present });
        } catch (err) {
          ctx.logger.warn(
            `transitous-mirror: feed_state write failed for ${key.region}/${key.name}: ${(err as Error).message}`,
          );
        }
        if (!present) {
          failures.push({
            id: source.id,
            country: feed.country,
            url: feed.url,
            message: `mirror: no published archive for ${feed.id}_${source.name}`,
          });
        }
      }
    }
    ctx.state.fetchFailures = [...(ctx.state.fetchFailures ?? []), ...failures];

    const selectedCount = ctx.state.selectedCount ?? 0;
    const fetchedCount = Math.max(0, selectedCount - failures.length);
    // Acquisition is completed as one transaction by fetch-operator. Keep
    // going so it can collect operator failures too, then fail once with the
    // complete desired-source evidence.
    const status: StageStatus = failures.length > 0 ? "partial" : "ok";

    return {
      stage: "mirror",
      status,
      startedAt,
      finishedAt: ctx.now(),
      durationMs: Date.now() - start,
      message:
        failures.length === 0
          ? `Mirrored ${selectedCount} feed source(s) from ${baseUrl}`
          : `Mirrored ${fetchedCount}/${selectedCount} source(s) from ${baseUrl}; ${failures.length} missing`,
      artifacts: { baseUrl, fetched: fetchedCount, missing: failures.length },
    };
  } catch (error) {
    const err = error as Error;
    return {
      stage: "mirror",
      status: "error",
      startedAt,
      finishedAt: ctx.now(),
      durationMs: Date.now() - start,
      message: err.message,
      error: { message: err.message, stack: err.stack },
    };
  }
};

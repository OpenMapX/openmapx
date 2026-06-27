import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyFeedOverlay, type FeedFile, readFeedOverlay } from "../transitous-feeds-overlay.js";
import {
  applyApiKeysOverlay,
  DEFAULT_TRANSITOUS_API_KEYS_PATH,
  DEFAULT_TRANSITOUS_FEEDS_OVERLAY_PATH,
  listTransitousFeedFiles,
  pruneUnresolvableSources,
  sumActiveGtfsSources,
} from "./internal.js";
import type { JobContext, JobLogger, StageFn } from "./types.js";

/**
 * Sanitise the catalog, apply API-key and feeds overlays, list catalog feed
 * files, then narrow them to the requested countries with active schedule
 * sources. Sets ctx.state.{feedFiles, selectedFeedFiles, requestedCount,
 * selectedCount, skippedCount, expectedFeedIds}.
 */
export const run: StageFn = async (ctx) => {
  const startedAt = ctx.now();
  const start = Date.now();
  try {
    const catalogDir = ctx.state.catalogDir ?? ctx.catalogDir;

    const apiKeysPath =
      ctx.apiKeysPath ?? process.env.TRANSITOUS_API_KEYS_PATH ?? DEFAULT_TRANSITOUS_API_KEYS_PATH;
    applyApiKeysOverlay(catalogDir, apiKeysPath);

    const feedsOverlayPath = resolveFeedsOverlayPath(ctx);
    const overlayPatchCount = applyFeedsOverlayToCatalog(catalogDir, feedsOverlayPath, ctx.logger);

    // Pre-skip anything upstream can't resolve by RUNNING its own resolver and
    // acting on the "Could not resolve" verdict (see pruneUnresolvableSources)
    // rather than reimplementing transitland.py. MUST run before the fetch
    // stage — fetch.py also exits on unresolvable sources, per feed file — and
    // after the overlays so operator-supplied keys/url-overrides are respected.
    const prunedUnresolvable = await pruneUnresolvableSources({
      catalogDir,
      countries: ctx.countries,
      runner: ctx.runner,
      logger: ctx.logger,
    });

    const allFeedFiles = listTransitousFeedFiles(catalogDir);
    const requestedCount = sumActiveGtfsSources(allFeedFiles);
    const countries = ctx.countries;
    const countryMatchedFeedFiles =
      countries.length === 0
        ? allFeedFiles
        : allFeedFiles.filter((feed) => countries.includes(feed.country));
    if (countries.length > 0 && countryMatchedFeedFiles.length === 0) {
      throw new Error(
        `Transitous catalog does not contain any feed files for countries: ${countries.join(", ")}`,
      );
    }
    const selectedFeedFiles = countryMatchedFeedFiles.filter(
      (feed) => feed.activeScheduleSources.length > 0,
    );
    const selectedCount = sumActiveGtfsSources(selectedFeedFiles);
    if (selectedCount === 0) {
      const scope =
        countries.length > 0
          ? `countries: ${countries.join(", ")}`
          : "the current Transitous catalog";
      throw new Error(`Transitous catalog does not contain any active GTFS feeds for ${scope}`);
    }
    const skippedCount = requestedCount - selectedCount;

    const expectedFeedIds = new Set(
      selectedFeedFiles.flatMap((feed) =>
        feed.activeScheduleSources.map((source) => source.id.toLowerCase()),
      ),
    );

    ctx.state.feedFiles = allFeedFiles;
    ctx.state.selectedFeedFiles = selectedFeedFiles;
    ctx.state.requestedCount = requestedCount;
    ctx.state.selectedCount = selectedCount;
    ctx.state.skippedCount = skippedCount;
    ctx.state.expectedFeedIds = expectedFeedIds;

    const skippedCountries: string[] =
      countries.length > 0
        ? allFeedFiles
            .filter((feed) => !countries.includes(feed.country))
            .map((feed) => feed.country)
            .filter((country, index, arr) => arr.indexOf(country) === index)
        : [];

    return {
      stage: "filter",
      status: "ok",
      startedAt,
      finishedAt: ctx.now(),
      durationMs: Date.now() - start,
      message: `Selected ${selectedFeedFiles.length} feed files (${selectedCount} sources)`,
      artifacts: {
        activeFeeds: selectedFeedFiles.length,
        skippedCountries,
        overlayPatchCount,
        requestedCount,
        selectedCount,
        skippedCount,
        prunedUnresolvable: prunedUnresolvable.length,
      },
    };
  } catch (error) {
    const err = error as Error;
    return {
      stage: "filter",
      status: "error",
      startedAt,
      finishedAt: ctx.now(),
      durationMs: Date.now() - start,
      message: err.message,
      error: { message: err.message, stack: err.stack },
    };
  }
};

/**
 * Resolve the path to the operator's feeds-overlay file. Priority:
 *   1. `ctx.feedsOverlayPath` (explicit override, used by tests)
 *   2. `TRANSITOUS_FEEDS_OVERLAY_PATH` env var (compose mounts)
 *   3. `<repoRoot>/infra/docker/data/overrides/feeds-overlay.json` (dev shell)
 *   4. `DEFAULT_TRANSITOUS_FEEDS_OVERLAY_PATH` (container default)
 */
function resolveFeedsOverlayPath(ctx: JobContext): string | undefined {
  if (ctx.feedsOverlayPath) return ctx.feedsOverlayPath;
  const fromEnv = process.env.TRANSITOUS_FEEDS_OVERLAY_PATH;
  if (fromEnv) return fromEnv;
  if (ctx.repoRoot) {
    return join(ctx.repoRoot, "infra", "docker", "data", "overrides", "feeds-overlay.json");
  }
  return DEFAULT_TRANSITOUS_FEEDS_OVERLAY_PATH;
}

/**
 * Apply operator-local patches from `feeds-overlay.json` into the catalog on
 * disk. Returns the number of patches found in the overlay (0 if the file is
 * absent), regardless of how many matched.
 */
function applyFeedsOverlayToCatalog(
  catalogDir: string,
  overlayPath: string | undefined,
  logger: JobLogger,
): number {
  if (!overlayPath) return 0;
  let overlay: ReturnType<typeof readFeedOverlay>;
  try {
    overlay = readFeedOverlay(overlayPath);
  } catch (error) {
    logger.warn(
      `transitous-pipeline: failed to read feeds overlay at ${overlayPath} (${(error as Error).message}); skipping overlay`,
    );
    return 0;
  }
  if (!overlay || overlay.patches.length === 0) return 0;
  logger.info(
    `transitous-pipeline: applying ${overlay.patches.length} feeds-overlay patch${overlay.patches.length === 1 ? "" : "es"} from ${overlayPath}`,
  );

  const regionsToPatch = new Set(overlay.patches.map((entry) => entry.region));
  const feedFiles: FeedFile[] = [];
  const feedPaths = new Map<string, string>();
  for (const region of regionsToPatch) {
    const feedPath = join(catalogDir, "feeds", `${region}.json`);
    if (!existsSync(feedPath)) {
      logger.warn(
        `transitous-pipeline: feeds-overlay region "${region}" has no matching catalog file (${feedPath})`,
      );
      continue;
    }
    try {
      const data = JSON.parse(readFileSync(feedPath, "utf-8")) as Record<string, unknown>;
      feedFiles.push({ ...data, region });
      feedPaths.set(region, feedPath);
    } catch (error) {
      logger.warn(
        `transitous-pipeline: failed to read ${feedPath} for feeds-overlay (${(error as Error).message})`,
      );
    }
  }

  const result = applyFeedOverlay(feedFiles, overlay);
  for (const feed of feedFiles) {
    const feedPath = feedPaths.get(feed.region);
    if (!feedPath) continue;
    // Strip the synthetic `region` key before re-serializing — it isn't
    // part of the Transitous catalog schema and would confuse fetch.py.
    const serialisable = { ...feed } as Record<string, unknown>;
    delete serialisable.region;
    writeFileSync(feedPath, `${JSON.stringify(serialisable, null, 2)}\n`, "utf-8");
  }
  for (const unmatched of result.unmatched) {
    logger.warn(
      `transitous-pipeline: feeds-overlay patch (region=${unmatched.region}, name=${unmatched.name}) had no matching source — silently no-oped`,
    );
  }
  return overlay.patches.length;
}

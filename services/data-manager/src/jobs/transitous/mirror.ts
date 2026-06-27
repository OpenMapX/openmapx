import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  mirrorArtifacts,
  parseLicenseManifest,
  TRANSITOUS_ARTIFACT_BASE_URL,
} from "@openmapx/transitous-core";
import { recordFetchOutcome } from "./feed-state-writer.js";
import type { StageFn, StageResult } from "./types.js";

/**
 * Mirror mode: download Transitous's published, already-processed artifacts
 * (`config.yml`, `*.gtfs.zip`, `license.json`, `scripts/*.lua`) into the build
 * output dir instead of cloning + running fetch.py/generate-motis-config.py.
 * Also seeds `feed_state` from the published `license.json` so the admin feed
 * tables stay populated without our own per-feed fetch accounting.
 *
 * The catalog clone still happens in `prepare` (mirror mode reuses it for the
 * realtime feed-proxy metadata in `mirror-config`); only the slow + fragile
 * fetch + gtfsclean + config-gen are replaced by this download.
 */
export const run: StageFn = async (ctx): Promise<StageResult> => {
  const startedAt = ctx.now();
  const start = Date.now();
  try {
    const baseUrl =
      ctx.artifactBaseUrl ??
      process.env.TRANSITOUS_ARTIFACT_BASE_URL ??
      TRANSITOUS_ARTIFACT_BASE_URL;
    const destDir = ctx.outDir;

    const commandCount = await mirrorArtifacts({
      baseUrl,
      destDir,
      countries: ctx.countries,
      runner: ctx.runner,
      logger: ctx.logger,
    });

    const configPath = join(destDir, "config.yml");
    if (!existsSync(configPath)) {
      throw new Error(`mirror did not produce ${configPath} (is ${baseUrl} reachable?)`);
    }

    let feedCount = 0;
    const licensePath = join(destDir, "license.json");
    if (existsSync(licensePath)) {
      const entries = parseLicenseManifest(readFileSync(licensePath, "utf-8"));
      for (const entry of entries) {
        const region = entry.regionCode ?? entry.countryCode;
        const name = entry.humanName;
        if (!region || !name) continue;
        try {
          await recordFetchOutcome({ region, name, ok: true });
          feedCount++;
        } catch (err) {
          ctx.logger.warn(
            `transitous-mirror: failed to record feed_state for ${region}/${name}: ${(err as Error).message}`,
          );
        }
      }
    } else {
      ctx.logger.warn("transitous-mirror: published license.json absent; feed_state not seeded");
    }

    return {
      stage: "mirror",
      status: "ok",
      startedAt,
      finishedAt: ctx.now(),
      durationMs: Date.now() - start,
      message: `Mirrored artifacts from ${baseUrl} (${feedCount} feeds from license manifest)`,
      artifacts: { baseUrl, commandCount, feedCount },
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

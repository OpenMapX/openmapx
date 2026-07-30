import {
  copyFileSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { CANDIDATE_PROXY_DIRNAME, createCandidateManifest } from "./candidate.js";
import { GTFS_ARCHIVE_RE } from "./internal.js";
import { TRANSIT_SOURCE_MANIFEST_FILENAME } from "./source-manifest.js";
import type { StageFn, StageResult } from "./types.js";

/**
 * Materialise a self-contained MOTIS working directory the staging container can
 * import from, populated from the Transitous build output (`ctx.outDir`, aka
 * `out/` — a symlink to `data/gtfs`).
 *
 * Why this stage exists: `gen-motis-config` writes `config.yml` (+ `scripts/`,
 * `license.json`) into `out/`, and `fetch` drops the GTFS archives there too,
 * but nothing previously copied that into the dir the `motis-staging` container
 * actually mounts. The container imports its working dir in place and writes the
 * (expensive) compiled timetable into a `data/` subdir there, and `promote`
 * atomically renames the whole staging dir over the live dir — so the staging
 * dir, not `out/`, is the unit the swap operates on.
 *
 * A complete MOTIS dir holds, at top level: `config.yml`, the GTFS archives the
 * config references, the OSM extract (`osm:` in the config) when street routing
 * is enabled, `scripts/` (per-feed colouring lua), and `license.json`. We
 * hardlink the bulky inputs (zero-copy on the shared `/data` tree) and copy the
 * small text files. The OSM extract isn't part of the Transitous GTFS output, so
 * we carry it forward from the current live dir when the config asks for one.
 *
 * Idempotent + rebuild-safe: re-laid every run, stale feed archives pruned, and
 * the container-written `data/` output subdir left intact so MOTIS's import cache
 * survives between cycles.
 */

/** Overwrite `dest` with a hardlink to `src`, falling back to a copy across devices. */
function linkOrCopy(src: string, dest: string): void {
  if (existsSync(dest)) rmSync(dest, { force: true });
  try {
    linkSync(src, dest);
  } catch {
    copyFileSync(src, dest);
  }
}

/** Extract the GTFS archive filenames + OSM extract a MOTIS `config.yml` references. */
export function parseConfigInputs(configText: string): { gtfs: string[]; osm?: string } {
  const gtfs = new Set<string>();
  for (const m of configText.matchAll(/^\s*path:\s*["']?([^"'\s]+)["']?\s*$/gm)) {
    if (m[1]) gtfs.add(m[1]);
  }
  const osmMatch = configText.match(/^\s*osm:\s*["']?([^"'\s]+)["']?\s*$/m);
  return { gtfs: [...gtfs], osm: osmMatch?.[1] };
}

export const run: StageFn = async (ctx) => {
  const startedAt = ctx.now();
  const start = Date.now();
  const finish = (
    status: StageResult["status"],
    message: string,
    artifacts?: Record<string, unknown>,
  ): StageResult => ({
    stage: "assemble-staging",
    status,
    startedAt,
    finishedAt: ctx.now(),
    durationMs: Date.now() - start,
    message,
    ...(artifacts ? { artifacts } : {}),
  });

  try {
    const outDir = ctx.outDir;
    const configSrc = join(outDir, "config.yml");
    if (!existsSync(configSrc)) {
      // gen-motis-config didn't produce a config (older catalog / fixture). The
      // downstream motis-import stage skips on a missing config too.
      return finish("skipped", `no config.yml at ${configSrc}; nothing to assemble`);
    }

    const configText = readFileSync(configSrc, "utf-8");
    const { gtfs, osm } = parseConfigInputs(configText);

    const stagingDir = ctx.motisStagingDataDir;
    mkdirSync(stagingDir, { recursive: true });

    // config.yml — the import-time entrypoint.
    linkOrCopy(configSrc, join(stagingDir, "config.yml"));

    // GTFS/NeTEx archives the config references — hardlinked from the build output.
    const linkedFeeds: string[] = [];
    const missingFeeds: string[] = [];
    for (const feed of gtfs) {
      const src = join(outDir, feed);
      if (existsSync(src)) {
        linkOrCopy(src, join(stagingDir, feed));
        linkedFeeds.push(feed);
      } else {
        missingFeeds.push(feed);
      }
    }

    // Prune top-level feed archives left over from a previous build that the
    // current config no longer references (keeps the dir matched to the config).
    const referenced = new Set(gtfs);
    for (const entry of readdirSync(stagingDir)) {
      if (GTFS_ARCHIVE_RE.test(entry) && !referenced.has(entry)) {
        rmSync(join(stagingDir, entry), { force: true });
      }
    }

    // OSM extract — not part of the GTFS output; carry it forward from the live
    // dir when the config asks for street routing.
    let osmSource: "out" | "live" | "missing" | "none" = "none";
    if (osm) {
      const fromOut = join(outDir, osm);
      const fromLive = join(ctx.motisDataDir, osm);
      if (existsSync(fromOut)) {
        linkOrCopy(fromOut, join(stagingDir, osm));
        osmSource = "out";
      } else if (existsSync(fromLive)) {
        linkOrCopy(fromLive, join(stagingDir, osm));
        osmSource = "live";
      } else {
        osmSource = "missing";
        ctx.logger.warn(
          `assemble-staging: config references osm "${osm}" but it is absent from both ${outDir} and the live dir ${ctx.motisDataDir}; street routing will fail to import`,
        );
      }
    }

    // Per-feed colouring scripts are optional; attribution is an immutable,
    // required candidate artifact and must have been finalized before assembly.
    const scriptsSrc = join(outDir, "scripts");
    if (existsSync(scriptsSrc)) {
      const scriptsDest = join(stagingDir, "scripts");
      rmSync(scriptsDest, { recursive: true, force: true });
      cpSync(scriptsSrc, scriptsDest, { recursive: true });
    }
    const licenseSrc = join(outDir, "license.json");
    if (!existsSync(licenseSrc)) {
      return finish("error", `required attribution artifact missing at ${licenseSrc}`);
    }
    linkOrCopy(licenseSrc, join(stagingDir, "license.json"));
    const sourceIndexSrc = join(outDir, "gbfs-source-index.json");
    if (existsSync(sourceIndexSrc)) {
      linkOrCopy(sourceIndexSrc, join(stagingDir, "gbfs-source-index.json"));
    }
    const transitSourceManifest = join(outDir, TRANSIT_SOURCE_MANIFEST_FILENAME);
    if (!existsSync(transitSourceManifest)) {
      return finish(
        "error",
        `required transit source manifest missing at ${transitSourceManifest}`,
      );
    }
    linkOrCopy(transitSourceManifest, join(stagingDir, TRANSIT_SOURCE_MANIFEST_FILENAME));

    const proxyCandidateSrc = join(outDir, CANDIDATE_PROXY_DIRNAME);
    if (!existsSync(proxyCandidateSrc)) {
      return finish("error", `required feed-proxy candidate missing at ${proxyCandidateSrc}`);
    }
    const proxyCandidateDest = join(stagingDir, CANDIDATE_PROXY_DIRNAME);
    rmSync(proxyCandidateDest, { recursive: true, force: true });
    cpSync(proxyCandidateSrc, proxyCandidateDest, { recursive: true });

    // Empty staging guard (hardStop): a config that stages 0 feeds would import
    // an empty timetable and promote it over the live one. Refuse — the pipeline
    // halts here, leaving live untouched. (A config genuinely referencing no
    // feeds, or one whose every referenced archive is missing from the output.)
    if (linkedFeeds.length === 0) {
      return finish(
        "error",
        `assembled 0 feed(s) into ${stagingDir}: refusing to import/promote an empty timetable` +
          (missingFeeds.length
            ? `; ${missingFeeds.length} referenced feed(s) missing from output`
            : "") +
          (osm ? `; osm ${osmSource}` : ""),
        { stagingDir, linkedFeeds: 0, missingFeeds, osm: osm ?? null, osmSource },
      );
    }

    const manifest = createCandidateManifest(
      stagingDir,
      ctx.jobId,
      ctx.now(),
      ctx.operationsPolicy,
    );

    const status = missingFeeds.length > 0 || osmSource === "missing" ? "partial" : "ok";
    return finish(
      status,
      `assembled ${linkedFeeds.length} feed(s) into ${stagingDir}` +
        (missingFeeds.length
          ? `; ${missingFeeds.length} referenced feed(s) missing from output`
          : "") +
        (osm ? `; osm ${osmSource}` : ""),
      {
        stagingDir,
        linkedFeeds: linkedFeeds.length,
        missingFeeds,
        osm: osm ?? null,
        osmSource,
        candidateEpoch: manifest.epoch,
        configHash: manifest.artifacts.config.sha256,
        licenseHash: manifest.artifacts.license.sha256,
      },
    );
  } catch (error) {
    const err = error as Error;
    return {
      stage: "assemble-staging",
      status: "error",
      startedAt,
      finishedAt: ctx.now(),
      durationMs: Date.now() - start,
      message: err.message,
      error: { message: err.message, stack: err.stack },
    };
  }
};

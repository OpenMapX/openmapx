import { existsSync, mkdirSync } from "node:fs";
import { ensureCatalog } from "@openmapx/transitous-core";
import { parseRefShaPair, readTransitousLock } from "../../transitous-lock.js";
import {
  DEFAULT_TRANSITOUS_REPO_URL,
  ensureTransitousWorkdirs,
  readGitHeadSha,
  readTransitlandAtlasSha,
  safeDirArgs,
} from "./internal.js";
import type { JobContext, JobLogger, StageFn, StageResult } from "./types.js";

/**
 * Clone/checkout the Transitous catalog at the locked ref, ensure submodules
 * are checked out, prepare the workdir symlinks, and prune orphaned GTFS
 * datasets from the state store. Populates ctx.state.{catalogDir,gtfsDir,
 * downloadsDir} for downstream stages.
 */
export const run: StageFn = async (ctx) => {
  const startedAt = ctx.now();
  const start = Date.now();
  try {
    mkdirSync(ctx.dataDir, { recursive: true });

    const catalogDir = ctx.catalogDir;
    // `||` (not `??`): compose injects `${VAR:-}` as an empty string when the
    // operator hasn't set it, and "" must fall through to the default.
    const repoUrl =
      ctx.transitousRepoUrl || process.env.TRANSITOUS_REPO_URL || DEFAULT_TRANSITOUS_REPO_URL;
    await ensureCatalog({
      dataDir: ctx.dataDir,
      catalogDir,
      repoUrl,
      runner: ctx.runner,
      reset: true,
    });

    await enforceTransitousLock(catalogDir, ctx.repoRoot, ctx.runner, ctx.logger);
    ensureTransitousWorkdirs(catalogDir, ctx.outDir, ctx.downloadsDir);
    pruneOrphanedGtfsDatasets(ctx);

    ctx.state.catalogDir = catalogDir;
    ctx.state.gtfsDir = ctx.outDir;
    ctx.state.downloadsDir = ctx.downloadsDir;

    const ref = await readGitHeadSha(catalogDir);
    const transitlandAtlasSha = readTransitlandAtlasSha(catalogDir);

    const finishedAt = ctx.now();
    return {
      stage: "prepare",
      status: "ok",
      startedAt,
      finishedAt,
      durationMs: Date.now() - start,
      message: `Transitous catalog ready at ${catalogDir}`,
      artifacts: {
        ref: ref || null,
        transitlandAtlasSha: transitlandAtlasSha ?? null,
      },
    };
  } catch (error) {
    const err = error as Error;
    return errorResult(startedAt, ctx.now(), start, err);
  }
};

function errorResult(
  startedAt: string,
  finishedAt: string,
  start: number,
  err: Error,
): StageResult {
  return {
    stage: "prepare",
    status: "error",
    startedAt,
    finishedAt,
    durationMs: Date.now() - start,
    message: err.message,
    error: { message: err.message, stack: err.stack },
  };
}

function pruneOrphanedGtfsDatasets(ctx: JobContext): void {
  for (const dataset of ctx.store.getAll()) {
    if (dataset.type !== "gtfs") continue;
    if (existsSync(dataset.path)) continue;
    ctx.store.remove("gtfs", dataset.id);
  }
}

/**
 * If a lockfile exists at `<repoRoot>/infra/docker/transitous.lock.json`,
 * hard-reset the catalog to the pinned SHA before running the pipeline.
 * When no lockfile exists, log a warning and continue.
 */
async function enforceTransitousLock(
  catalogDir: string,
  repoRoot: string | undefined,
  runner: JobContext["runner"],
  logger: JobLogger,
): Promise<void> {
  if (!repoRoot) {
    logger.warn(
      "transitous-pipeline: no repoRoot supplied; skipping lockfile enforcement (run `pnpm openmapx transitous bump` to pin)",
    );
    return;
  }
  let lock: ReturnType<typeof readTransitousLock>;
  try {
    lock = readTransitousLock(repoRoot);
  } catch (error) {
    logger.warn(
      `transitous-pipeline: failed to read lockfile (${(error as Error).message}); continuing without pin`,
    );
    return;
  }
  if (!lock) {
    logger.warn(
      "transitous-pipeline: no infra/docker/transitous.lock.json found; running against catalog HEAD (run `pnpm openmapx transitous bump` to pin)",
    );
    return;
  }
  const { sha } = parseRefShaPair(lock.ref);
  const safeArgs = safeDirArgs(catalogDir);
  const currentSha = await readGitHeadSha(catalogDir);
  if (currentSha === sha) return;
  logger.info(
    `transitous-pipeline: catalog HEAD ${currentSha || "(unknown)"} differs from lockfile ${sha}; resetting`,
  );
  await runner("git", [...safeArgs, "-C", catalogDir, "fetch", "origin", sha], {
    cwd: catalogDir,
    stdio: "pipe",
  });
  await runner("git", [...safeArgs, "-C", catalogDir, "checkout", "--force", sha], {
    cwd: catalogDir,
    stdio: "pipe",
  });
  await runner(
    "git",
    [...safeArgs, "-C", catalogDir, "submodule", "update", "--init", "--checkout", "--force"],
    { cwd: catalogDir, stdio: "pipe" },
  );
}

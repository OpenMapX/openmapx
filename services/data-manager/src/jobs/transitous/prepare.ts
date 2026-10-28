import { existsSync, mkdirSync } from "node:fs";
import { parseCatalogPinSet } from "@openmapx/core/catalog-pins";
import { ensureCatalog } from "@openmapx/transitous-core";
import { runOpsOperation } from "../../ops-client.js";
import { parseRefShaPair, type TransitousLock } from "../../transitous-lock.js";
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
    if (ctx.useProposedLock)
      throw Error("Paired proposal validation requires the reviewed activation workflow");
    const pins = await runOpsOperation({ kind: "catalogPins.inspect" });
    if (!pins.active || pins.catalogRevisionId !== pins.active.generationId)
      throw Error("Paired catalog pins are unavailable");
    try {
      ctx.state.catalogPins = parseCatalogPinSet(pins.active);
    } catch {
      throw Error("Paired catalog pin response is invalid");
    }
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

    ctx.state.transitousLock = await enforceTransitousLock(
      catalogDir,
      ctx.runner,
      ctx.logger,
      ctx.state.catalogPins.transitous,
    );
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

/** A pinned catalog commit is an exact 40-character object id, nothing shorter. */
const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/;

/**
 * Hard-reset the catalog to the SHA pinned in
 * the agent-owned `infra/docker/transitous.lock.json` before running the pipeline.
 *
 * This fails CLOSED. A missing repo root, a missing, unreadable, or malformed
 * lockfile, or a ref whose SHA is not an exact 40-hex commit all abort
 * preparation. Continuing would run upstream Transitous code against whatever
 * the catalog's remote HEAD happens to be — code that was never reviewed and is
 * not what any operator pinned.
 */
async function enforceTransitousLock(
  catalogDir: string,
  runner: JobContext["runner"],
  logger: JobLogger,
  pinned: TransitousLock,
): Promise<TransitousLock> {
  const lock = pinned;
  let sha: string;
  try {
    ({ sha } = parseRefShaPair(lock.ref));
  } catch (error) {
    throw new Error(
      `transitous-pipeline: refusing to run — the catalog lock ref is malformed (${(error as Error).message})`,
    );
  }
  if (!FULL_COMMIT_SHA.test(sha)) {
    // An abbreviated SHA is ambiguous and a symbolic ref is mutable; neither
    // identifies exactly one reviewed commit.
    throw new Error(
      "transitous-pipeline: refusing to run — the catalog lock must pin an exact 40-character commit",
    );
  }
  const safeArgs = safeDirArgs(catalogDir);
  const currentSha = await readGitHeadSha(catalogDir);
  if (currentSha === sha) return lock;
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
  return lock;
}

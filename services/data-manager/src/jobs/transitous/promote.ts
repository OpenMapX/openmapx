import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { verifyCandidateManifest } from "./candidate.js";
import { runFunctionalProbes, verifyCapabilitySnapshot } from "./functional-probes.js";
import { IMPORT_MARKER_FILE } from "./internal.js";
import { PRIMARY_CONTAINER, STAGING_CONTAINER } from "./motis-containers.js";
import { mapInitialUrl } from "./motis-endpoints.js";
import { parseIntEnv, pollUntilHealthy } from "./motis-probe.js";
import { commitProxyTransaction } from "./proxy-transaction.js";
import type { JobContext, StageFn, StageResult } from "./types.js";

const PRIMARY_URL = process.env.MOTIS_URL ?? "http://localhost:8081";
const STAGING_URL = process.env.MOTIS_STAGING_URL ?? "http://localhost:8082";

const SMOKE_BUDGET_MS = 30_000;
// How long to wait for the primary to come back healthy after the swap+restart.
// The restarted container re-loads the promoted dataset before it binds its
// server — for a real region (e.g. Germany) that's several minutes, so a tight
// budget false-times-out and triggers an unnecessary rollback of a good build.
// Override with MOTIS_PROMOTE_RESTART_TIMEOUT_MS.
const RESTART_BUDGET_MS = parseIntEnv("MOTIS_PROMOTE_RESTART_TIMEOUT_MS", 20 * 60 * 1000);
const RESTART_POLL_INTERVAL_MS = 5_000;

/**
 * Artifacts MOTIS writes into the working dir's `data/` subdir during a
 * successful import (verified against a live MOTIS 2.10.2 dataset: `data/tt.bin`
 * is the compiled timetable, `data/meta` the import metadata, `data/osr`/`data/adr`
 * the street-routing + address indexes). Used only as a fallback when the
 * data-manager-written {@link IMPORT_MARKER_FILE} is absent (e.g. an operator
 * hand-populated staging from an out-of-band MOTIS run).
 */
const STAGING_SENTINEL_FILES = ["data/tt.bin", "data/meta", "data/osr", "data/adr"];

/**
 * `config.yml` is written by the gen-motis-config stage and is the one
 * artifact we can rely on every successful run producing. Used as the
 * outer guard before we look for any import marker.
 */
const STAGING_CONFIG_FILE = "config.yml";

interface PromoteArtifacts {
  promotedAt: string;
  smokeTestDurationMs: number;
  restartDurationMs: number;
  previousDir: string;
  rollback: boolean;
  rollbackReason?: string;
}

/**
 * Smoke probes against the staging MOTIS instance. Mirrors {@link motis-health}
 * but is owned by the promote stage so we can fail-fast right at the swap
 * boundary even if `motis-health` was skipped. Returns the failure reason or
 * `null` when all probes pass.
 */
/**
 * Decide whether `dir` looks like a freshly-finished MOTIS import worth
 * promoting. Three gates, in priority order:
 *
 *   1. `config.yml` must exist. Without the gen-motis-config artifact
 *      there is no defined target for `motis import` and the rest of the
 *      checks are moot.
 *   2. EITHER the data-manager-written {@link IMPORT_MARKER_FILE} is
 *      present (proves the motis-import stage completed in this pipeline
 *      run), OR
 *   3. at least one of the {@link STAGING_SENTINEL_FILES} is present
 *      (fallback for operators who hand-imported MOTIS out-of-band).
 *
 * The previous implementation degraded to a tautological "directory
 * non-empty" check, which let a partially-written staging volume pass
 * the gate. We deliberately do NOT keep that fallback — empty or junk-
 * filled staging dirs should fail closed.
 */
function isImportShaped(dir: string): boolean {
  if (!existsSync(dir)) return false;
  try {
    if (!existsSync(join(dir, STAGING_CONFIG_FILE))) return false;
    if (existsSync(join(dir, IMPORT_MARKER_FILE))) return true;
    return STAGING_SENTINEL_FILES.some((name) => existsSync(join(dir, name)));
  } catch {
    return false;
  }
}

async function waitForPrimaryHealthy(deadline: number): Promise<string | null> {
  const fail = await pollUntilHealthy(mapInitialUrl(PRIMARY_URL), deadline, {
    intervalMs: RESTART_POLL_INTERVAL_MS,
  });
  if (!fail) return null;
  return `primary MOTIS at ${mapInitialUrl(PRIMARY_URL)} did not become healthy within ${RESTART_BUDGET_MS}ms (${fail.reason})`;
}

/**
 * Stop a container before the rename swap. We stop BOTH the primary and the
 * staging container: the primary so we don't rename its mount out from under it,
 * and staging because it holds the very directory we're about to rename into
 * `live` — if it keeps that bind-mount inode open, the restarted primary ends up
 * sharing the same data dir with a second MOTIS process and its import hangs
 * (the server never binds → promote times out → rollback). The next pipeline
 * cycle's motis-import `docker restart`s staging again. Best effort: a
 * not-running / not-yet-created container makes `docker stop` fail, which is
 * fine — there's nothing to protect.
 */
async function stopContainer(ctx: JobContext, container: string): Promise<void> {
  try {
    await ctx.runner("docker", ["stop", container], {
      cwd: ctx.dataDir,
      stdio: "pipe",
    });
  } catch {
    // Not running / doesn't exist — nothing to stop.
  }
}

async function restartPrimary(ctx: JobContext): Promise<string | null> {
  try {
    await ctx.runner("docker", ["restart", PRIMARY_CONTAINER], {
      cwd: ctx.dataDir,
      stdio: "pipe",
    });
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

/**
 * Try to revert a completed rename. The pre-swap state was:
 *   current = data/motis/live           (live, just-replaced by staging)
 *   previous = data/motis/live.previous (the old live data)
 *   staging = data/motis/staging        (gone — became current)
 *
 * Best-effort: rename current → staging, previous → current. On any error
 * we leave the filesystem as-is and surface a descriptive reason. The
 * operator can then manually rescue via `mv data/motis/live.previous-broken
 * data/motis/live`.
 */
function tryRollback(
  currentDir: string,
  stagingDir: string,
  previousDir: string,
): { ok: true } | { ok: false; reason: string } {
  try {
    if (!existsSync(previousDir)) {
      return { ok: false, reason: `previous dir ${previousDir} missing; cannot rollback` };
    }
    if (existsSync(stagingDir)) {
      // Staging was recreated empty after the swap; remove the empty shell
      // so we can move current → staging cleanly.
      rmSync(stagingDir, { recursive: true, force: true });
    }
    if (existsSync(currentDir)) renameSync(currentDir, stagingDir);
    renameSync(previousDir, currentDir);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
}

/**
 * Atomic-swap promote.
 *
 * Sequence:
 *
 *   1. Pre-flight: staging dir exists and looks import-shaped.
 *   2. Smoke probes against staging MOTIS (`/map/initial`, `/map/stops`, `/plan`).
 *   3. `docker stop motis`, then rename `data/motis/live` →
 *      `data/motis/live.previous` and `data/motis/staging` →
 *      `data/motis/live` (so the rename never happens under a running mount).
 *      Recreate an empty staging dir so the next pipeline run has a clean target.
 *   4. `docker restart motis` and poll `/api/v1/map/initial` until it responds
 *      (5-minute budget).
 *
 * Rollback paths:
 *   - Smoke probes fail → no rename happens; return error.
 *   - First rename succeeds but the second fails → restore the first.
 *   - Restart fails or primary never becomes healthy → revert renames,
 *     restart again. If THAT fails, leave a `data/motis/live.previous-broken`
 *     directory and return error with operator instructions.
 */
export const run: StageFn = async (ctx) => {
  const startedAt = ctx.now();
  const start = Date.now();
  const currentDir = ctx.motisDataDir;
  const stagingDir = ctx.motisStagingDataDir;
  const previousDir = `${currentDir}.previous`;

  try {
    if (!isImportShaped(stagingDir)) {
      // No staging data to promote (no import ran, or staging cleared after
      // a successful previous promotion). This is the normal path for tests
      // and dev runs that skipped the motis-import stage. Surface as skipped
      // rather than failing the pipeline.
      return {
        stage: "promote",
        status: "skipped",
        startedAt,
        finishedAt: ctx.now(),
        durationMs: Date.now() - start,
        message: `staging dir ${stagingDir} is missing or empty; nothing to promote`,
      } satisfies StageResult;
    }

    const manifest = verifyCandidateManifest(stagingDir);
    verifyCapabilitySnapshot(stagingDir, manifest);
    const smokeStart = Date.now();
    const smokeReport = await runFunctionalProbes(
      STAGING_URL,
      manifest,
      smokeStart + SMOKE_BUDGET_MS,
    );
    const smokeTestDurationMs = Date.now() - smokeStart;
    if (!smokeReport.ok) {
      return {
        stage: "promote",
        status: "error",
        startedAt,
        finishedAt: ctx.now(),
        durationMs: Date.now() - start,
        message: `aborting promote: staging probe "${smokeReport.failure?.name}" failed: ${smokeReport.failure?.evidence}`,
        artifacts: { smokeTestDurationMs, rollback: false, probes: smokeReport.outcomes },
      } satisfies StageResult;
    }

    // Clear the leftover previous from the last cycle (we only keep one cycle
    // of rollback history on disk).
    if (existsSync(previousDir)) {
      rmSync(previousDir, { recursive: true, force: true });
    }

    // Stop BOTH containers before touching the data dirs: the primary so the
    // rename never happens under its running mount, and staging because it holds
    // the dir we're about to rename into `live` — leaving it running would make
    // the restarted primary share the same data inode with a second MOTIS and
    // its import would hang (server never binds). The restart below brings the
    // primary back against the freshly-promoted data; the next pipeline cycle
    // restarts staging.
    await stopContainer(ctx, PRIMARY_CONTAINER);
    await stopContainer(ctx, STAGING_CONTAINER);

    // First rename: current → previous. If current doesn't exist (first ever
    // promotion) we skip this step and let the staging dir become the live
    // dir directly.
    let firstRenameDone = false;
    try {
      if (existsSync(currentDir)) {
        renameSync(currentDir, previousDir);
        firstRenameDone = true;
      }
    } catch (error) {
      // We stopped the primary above; bring it back before returning so a
      // rename failure doesn't leave it down on the (unchanged) old data.
      await restartPrimary(ctx);
      return {
        stage: "promote",
        status: "error",
        startedAt,
        finishedAt: ctx.now(),
        durationMs: Date.now() - start,
        message: `rename ${currentDir} -> ${previousDir} failed: ${(error as Error).message}`,
        artifacts: { smokeTestDurationMs, rollback: false },
      } satisfies StageResult;
    }

    // Second rename: staging → current.
    try {
      renameSync(stagingDir, currentDir);
    } catch (error) {
      // Roll back the first rename if it happened.
      if (firstRenameDone) {
        try {
          renameSync(previousDir, currentDir);
        } catch {
          // Swallow — the outer error is more useful.
        }
      }
      // Restore the primary we stopped above on the (rolled-back) old data.
      await restartPrimary(ctx);
      return {
        stage: "promote",
        status: "error",
        startedAt,
        finishedAt: ctx.now(),
        durationMs: Date.now() - start,
        message: `rename ${stagingDir} -> ${currentDir} failed: ${(error as Error).message}`,
        artifacts: { smokeTestDurationMs, rollback: firstRenameDone },
      } satisfies StageResult;
    }

    // Recreate an empty staging dir for the next cycle.
    try {
      mkdirSync(stagingDir, { recursive: true });
    } catch {
      // Non-fatal: the next pipeline run will recreate it.
    }

    // Restart the primary MOTIS so it picks up the new data.
    const restartStart = Date.now();
    const restartErr = await restartPrimary(ctx);
    if (restartErr) {
      // Rollback rename and try to restart again so we at least restore the
      // previous live state.
      const rb = tryRollback(currentDir, stagingDir, previousDir);
      const secondRestartErr = await restartPrimary(ctx);
      const restartDurationMs = Date.now() - restartStart;
      // Worst case: rollback failed AND restart still fails. Mark the broken
      // state on disk so the operator can inspect/recover manually.
      if (!rb.ok && secondRestartErr && existsSync(previousDir)) {
        try {
          renameSync(previousDir, `${previousDir}-broken`);
        } catch {
          // Best effort — surface the original error.
        }
      }
      const rollbackMsg = rb.ok ? "ok" : `failed: ${(rb as { reason: string }).reason}`;
      const restartMsg = secondRestartErr
        ? `; second restart also failed: ${secondRestartErr}`
        : "";
      const brokenMsg =
        !rb.ok && secondRestartErr ? `; broken previous dir left at ${previousDir}-broken` : "";
      return {
        stage: "promote",
        status: "error",
        startedAt,
        finishedAt: ctx.now(),
        durationMs: Date.now() - start,
        message: `motis restart failed (${restartErr}); rollback ${rollbackMsg}${restartMsg}${brokenMsg}`,
        artifacts: {
          smokeTestDurationMs,
          restartDurationMs,
          rollback: rb.ok,
          rollbackReason: rb.ok ? undefined : (rb as { reason: string }).reason,
        },
      } satisfies StageResult;
    }

    const restartDeadline = restartStart + RESTART_BUDGET_MS;
    const healthErr = await waitForPrimaryHealthy(restartDeadline);
    const restartDurationMs = Date.now() - restartStart;
    if (healthErr) {
      // Roll back rename and restart again — same flow as restart failure.
      const rb = tryRollback(currentDir, stagingDir, previousDir);
      const secondRestartErr = await restartPrimary(ctx);
      const rollbackMsg = rb.ok ? "ok" : `failed: ${(rb as { reason: string }).reason}`;
      const restartMsg = secondRestartErr ? `; second restart failed: ${secondRestartErr}` : "";
      return {
        stage: "promote",
        status: "error",
        startedAt,
        finishedAt: ctx.now(),
        durationMs: Date.now() - start,
        message: `${healthErr}; rollback ${rollbackMsg}${restartMsg}`,
        artifacts: {
          smokeTestDurationMs,
          restartDurationMs,
          rollback: rb.ok,
          rollbackReason: rb.ok ? undefined : (rb as { reason: string }).reason,
        },
      } satisfies StageResult;
    }

    // Activation is not committed until the primary passes the identical
    // immutable-manifest gate. Any failure immediately restores the old dir.
    const primaryReport = await runFunctionalProbes(
      PRIMARY_URL,
      manifest,
      Date.now() + SMOKE_BUDGET_MS,
    );
    if (!primaryReport.ok) {
      const rb = tryRollback(currentDir, stagingDir, previousDir);
      const secondRestartErr = await restartPrimary(ctx);
      const rollbackMsg = rb.ok ? "ok" : `failed: ${(rb as { reason: string }).reason}`;
      const restartMsg = secondRestartErr ? `; rollback restart failed: ${secondRestartErr}` : "";
      return {
        stage: "promote",
        status: "error",
        startedAt,
        finishedAt: ctx.now(),
        durationMs: Date.now() - start,
        message: `primary probe "${primaryReport.failure?.name}" failed: ${primaryReport.failure?.evidence}; rollback ${rollbackMsg}${restartMsg}`,
        artifacts: {
          smokeTestDurationMs,
          restartDurationMs,
          rollback: rb.ok,
          rollbackReason: rb.ok ? undefined : (rb as { reason: string }).reason,
          probes: primaryReport.outcomes,
          candidateEpoch: manifest.epoch,
        },
      } satisfies StageResult;
    }

    try {
      await commitProxyTransaction(ctx);
    } catch (error) {
      const rb = tryRollback(currentDir, stagingDir, previousDir);
      await restartPrimary(ctx);
      return {
        stage: "promote",
        status: "error",
        startedAt,
        finishedAt: ctx.now(),
        durationMs: Date.now() - start,
        message: `${(error as Error).message}; data rollback ${rb.ok ? "ok" : "failed"}`,
        artifacts: { rollback: rb.ok, candidateEpoch: manifest.epoch },
      } satisfies StageResult;
    }

    const artifacts: PromoteArtifacts = {
      promotedAt: ctx.now(),
      smokeTestDurationMs,
      restartDurationMs,
      previousDir,
      rollback: false,
    };

    return {
      stage: "promote",
      status: "ok",
      startedAt,
      finishedAt: ctx.now(),
      durationMs: Date.now() - start,
      message: `promoted staging -> ${currentDir}; primary restarted in ${restartDurationMs}ms`,
      artifacts: {
        ...(artifacts as unknown as Record<string, unknown>),
        candidateEpoch: manifest.epoch,
        activeEpoch: manifest.epoch,
        configHash: manifest.artifacts.config.sha256,
        licenseHash: manifest.artifacts.license.sha256,
        probes: primaryReport.outcomes,
      },
    } satisfies StageResult;
  } catch (error) {
    const err = error as Error;
    return {
      stage: "promote",
      status: "error",
      startedAt,
      finishedAt: ctx.now(),
      durationMs: Date.now() - start,
      message: err.message,
      error: { message: err.message, stack: err.stack },
    } satisfies StageResult;
  }
};

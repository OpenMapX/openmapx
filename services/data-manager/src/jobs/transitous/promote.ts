import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { IMPORT_MARKER_FILE } from "./internal.js";
import type { JobContext, StageFn, StageResult } from "./types.js";

const PRIMARY_CONTAINER = "motis";
const PRIMARY_URL = process.env.MOTIS_URL ?? "http://localhost:8081";
const STAGING_URL = process.env.MOTIS_STAGING_URL ?? "http://localhost:8082";

const PROBE_TIMEOUT_MS = 5_000;
const SMOKE_BUDGET_MS = 30_000;
const RESTART_BUDGET_MS = 5 * 60 * 1000;
const RESTART_POLL_INTERVAL_MS = 5_000;

/**
 * Files MOTIS writes during a successful import. Names + locations come from
 * the upstream Transitous CI pipeline (`out/data/meta/*.json` after
 * `motis import`). We check both layouts — meta-nested AND flat — because
 * the staging volume layout depends on which MOTIS version + config the
 * operator runs. Used only as a fallback when the data-manager-written
 * {@link IMPORT_MARKER_FILE} is absent (e.g. an operator hand-populated
 * staging from an out-of-band MOTIS run).
 */
const STAGING_SENTINEL_FILES = [
  "tt.json",
  "meta/tt.json",
  "adr_extend.json",
  "meta/adr_extend.json",
  "osr_footpath.json",
  "meta/osr_footpath.json",
];

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

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function probe(url: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<string | null> {
  try {
    const res = await fetchWithTimeout(url, timeoutMs);
    if (!res.ok) return `HTTP ${res.status}`;
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.toLowerCase().includes("json")) return `unexpected content-type ${ct || "(none)"}`;
    await res.json();
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

/**
 * Smoke probes against the staging MOTIS instance. Mirrors {@link motis-health}
 * but is owned by the promote stage so we can fail-fast right at the swap
 * boundary even if `motis-health` was skipped. Returns the failure reason or
 * `null` when all probes pass.
 */
async function runSmokeProbes(deadline: number): Promise<string | null> {
  const stops = `${STAGING_URL}/api/v1/stops?min=52.515,13.359&max=52.535,13.379`;
  const plan = `${STAGING_URL}/api/v1/plan?fromPlace=52.525,13.369&toPlace=48.14,11.558`;
  const probes: Array<{ name: string; url: string }> = [
    { name: "initial", url: `${STAGING_URL}/api/v1/initial` },
    { name: "stops", url: stops },
    { name: "plan", url: plan },
  ];
  for (const p of probes) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return `total smoke-test budget exceeded before probe "${p.name}"`;
    const reason = await probe(p.url, Math.min(PROBE_TIMEOUT_MS, remaining));
    if (reason) return `staging probe "${p.name}" failed: ${reason}`;
  }
  return null;
}

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
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const fail = await probe(
      `${PRIMARY_URL}/api/v1/initial`,
      Math.min(PROBE_TIMEOUT_MS, remaining),
    );
    if (!fail) return null;
    const sleep = Math.min(RESTART_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now()));
    if (sleep === 0) break;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, sleep);
      if (typeof t.unref === "function") t.unref();
    });
  }
  return `primary MOTIS at ${PRIMARY_URL}/api/v1/initial did not return 200 within ${RESTART_BUDGET_MS}ms`;
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
 *   current = data/motis-data         (live, just-replaced by staging)
 *   previous = data/motis-data.previous (the old live data)
 *   staging = data/motis-staging-data  (gone — became current)
 *
 * Best-effort: rename current → staging, previous → current. On any error
 * we leave the filesystem as-is and surface a descriptive reason. The
 * operator can then manually rescue via `mv data/motis-data.previous-broken
 * data/motis-data`.
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
 *   2. Smoke probes against staging MOTIS (`/initial`, `/stops`, `/plan`).
 *   3. Rename `data/motis-data` → `data/motis-data.previous`, then
 *      `data/motis-staging-data` → `data/motis-data`. Recreate an empty
 *      staging dir so the next pipeline run has a clean target.
 *   4. `docker restart motis` and poll `/api/v1/initial` until it responds
 *      (5-minute budget).
 *
 * Rollback paths:
 *   - Smoke probes fail → no rename happens; return error.
 *   - First rename succeeds but the second fails → restore the first.
 *   - Restart fails or primary never becomes healthy → revert renames,
 *     restart again. If THAT fails, leave a `data/motis-data.previous-broken`
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

    const smokeStart = Date.now();
    const smokeDeadline = smokeStart + SMOKE_BUDGET_MS;
    const smokeFail = await runSmokeProbes(smokeDeadline);
    const smokeTestDurationMs = Date.now() - smokeStart;
    if (smokeFail) {
      return {
        stage: "promote",
        status: "error",
        startedAt,
        finishedAt: ctx.now(),
        durationMs: Date.now() - start,
        message: `aborting promote: ${smokeFail}`,
        artifacts: { smokeTestDurationMs, rollback: false },
      } satisfies StageResult;
    }

    // Clear the leftover previous from the last cycle (we only keep one cycle
    // of rollback history on disk).
    if (existsSync(previousDir)) {
      rmSync(previousDir, { recursive: true, force: true });
    }

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
      artifacts: artifacts as unknown as Record<string, unknown>,
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

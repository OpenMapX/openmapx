import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { verifyCandidateManifestAsync } from "./candidate.js";
import { IMPORT_MARKER_FILE } from "./internal.js";
import { STAGING_CONTAINER as STAGING_CONTAINER_NAME } from "./motis-containers.js";
import { assertTransitForward, preserveTransitPending, runTransitOwnedPhase } from "./owned-ops.js";
import type { StageFn, StageResult } from "./types.js";

/**
 * Trigger a fresh MOTIS import of the just-generated staging config.
 *
 * The staging container's command waits for `config.yml` then runs
 * `/motis import && /motis server` (see the motis-staging manifest), so the
 * import is owned by the container's own lifecycle: a `docker restart` re-runs it
 * against the freshly-assembled staging dir, then serves. We deliberately do NOT
 * also `docker exec /motis import` — that would race the entrypoint's import,
 * writing the same `data/` directory from two processes at once. The container is
 * brought up by the deploy step (it's in the rendered stack), so `docker restart`
 * also covers the stopped / waiting-for-config cases without needing to create it.
 *
 * Import *completion* is verified by the downstream motis-health stage (which
 * polls the staging server until it serves), so this stage returns as soon as
 * the (re)start is issued. On a failure to (re)start the container the stage
 * returns `status: "error"` with a short message so operators can diagnose.
 *
 * The data-manager container intentionally has the host docker socket mounted
 * (see app-api bind mount for the same `@docker-socket` pattern). When running
 * outside a container — local dev, tests with a mock runner — the runner just
 * receives the same args.
 */
export const run: StageFn = async (ctx) => {
  const startedAt = ctx.now();
  const start = Date.now();

  try {
    // Pre-flight: the staging data dir is expected to have been populated with
    // GTFS archives and a generated config.yml by upstream stages. If it isn't,
    // there's nothing meaningful to import — skip with a clear message rather
    // than failing.
    if (!existsSync(ctx.motisStagingDataDir)) {
      return {
        stage: "motis-import",
        status: "skipped",
        startedAt,
        finishedAt: ctx.now(),
        durationMs: Date.now() - start,
        message: `staging data dir ${ctx.motisStagingDataDir} does not exist`,
      } satisfies StageResult;
    }
    const expectedConfig = join(ctx.motisStagingDataDir, "config.yml");
    if (!existsSync(expectedConfig)) {
      return {
        stage: "motis-import",
        status: "skipped",
        startedAt,
        finishedAt: ctx.now(),
        durationMs: Date.now() - start,
        message: `staging config not generated at ${expectedConfig}`,
      } satisfies StageResult;
    }
    const manifest = await verifyCandidateManifestAsync(ctx.motisStagingDataDir, ctx.abortSignal);

    // Recreate the staging container against the newly selected inactive slot.
    // Docker resolves a bind source once at container creation: a restart would
    // retain an old slot after a previous promotion changed the staging alias.
    // The agent uses the existing rendered service and --no-deps so this cannot
    // start the control plane or dependency containers.
    try {
      // Restarting a container is host authority; the agent owns the name.
      await runTransitOwnedPhase(ctx, "restart-staging");
    } catch (error) {
      preserveTransitPending(ctx, error);
      const err = error as Error;
      return {
        stage: "motis-import",
        status: "error",
        startedAt,
        finishedAt: ctx.now(),
        durationMs: Date.now() - start,
        message: `failed to (re)start ${STAGING_CONTAINER_NAME} (is it in the service selection and is the stack up?): ${err.message}`,
        error: { message: err.message, stack: err.stack },
      } satisfies StageResult;
    }
    const action = "restarted" as const;

    const durationMs = Date.now() - start;
    const finishedAt = ctx.now();
    // Drop a small marker file the promote stage uses as the strong signal
    // that this pipeline run triggered an import of this staging volume.
    // Best-effort: if the write fails (read-only mount, race with restart) we
    // still return ok and let promote fall through to its MOTIS-file sentinel.
    try {
      assertTransitForward(ctx);
      writeFileSync(
        join(ctx.motisStagingDataDir, IMPORT_MARKER_FILE),
        `${JSON.stringify(
          {
            finishedAt,
            action,
            container: STAGING_CONTAINER_NAME,
            candidateEpoch: manifest.epoch,
            configHash: manifest.artifacts.config.sha256,
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );
    } catch {
      /* non-fatal */
    }
    return {
      stage: "motis-import",
      status: "ok",
      startedAt,
      finishedAt,
      durationMs,
      message: `${STAGING_CONTAINER_NAME} ${action}; import runs via the container entrypoint`,
      artifacts: {
        action,
        container: STAGING_CONTAINER_NAME,
        candidateEpoch: manifest.epoch,
        configHash: manifest.artifacts.config.sha256,
      },
    } satisfies StageResult;
  } catch (error) {
    preserveTransitPending(ctx, error);
    const err = error as Error;
    return {
      stage: "motis-import",
      status: "error",
      startedAt,
      finishedAt: ctx.now(),
      durationMs: Date.now() - start,
      message: err.message,
      error: { message: err.message, stack: err.stack },
    } satisfies StageResult;
  }
};

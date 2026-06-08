import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IMPORT_MARKER_FILE } from "./internal.js";
import { STAGING_CONTAINER as STAGING_CONTAINER_NAME } from "./motis-containers.js";
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

    // Re-run the staging container's import+serve entrypoint against the freshly
    // assembled config. `docker restart` covers every state the container can be
    // in: running (re-import the new data), stopped (start it), or blocked in its
    // wait-for-config loop (the restart picks up the now-present config.yml). The
    // import itself is owned by the container entrypoint; completion is verified
    // downstream by motis-health, so we return as soon as the restart is issued.
    //
    // Creating the container is NOT our job: motis-staging is part of the
    // rendered stack (plain bind-mount, pinned container name), brought up by the
    // deploy step. A missing container is an operator/selection error we surface
    // rather than paper over with `docker compose up` — the data-manager image
    // ships only a static docker CLI (no compose plugin), so that path can't run
    // here anyway.
    try {
      await ctx.runner("docker", ["restart", STAGING_CONTAINER_NAME], {
        cwd: ctx.dataDir,
        stdio: "pipe",
      });
    } catch (error) {
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
      writeFileSync(
        join(ctx.motisStagingDataDir, IMPORT_MARKER_FILE),
        `${JSON.stringify(
          {
            finishedAt,
            action,
            container: STAGING_CONTAINER_NAME,
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
      },
    } satisfies StageResult;
  } catch (error) {
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

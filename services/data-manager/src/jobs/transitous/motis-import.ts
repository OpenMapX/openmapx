import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IMPORT_MARKER_FILE } from "./internal.js";
import { STAGING_CONTAINER as STAGING_CONTAINER_NAME } from "./motis-containers.js";
import type { StageFn, StageResult } from "./types.js";

/**
 * Trigger a fresh MOTIS import of the just-generated staging config.
 *
 * The staging container's command is `/motis import && /motis server` (see the
 * motis-staging manifest), so the import is owned by the container's own
 * lifecycle: a `docker restart` re-runs it against the freshly-rendered
 * `config.yml` on the staging volume, then serves. We deliberately do NOT also
 * `docker exec /motis import` — that would race the entrypoint's import,
 * writing the same `data/` directory from two processes at once. If the
 * container doesn't exist yet (first run / fresh stack), `docker compose up -d`
 * creates and starts it; its entrypoint then performs the single import.
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

    // Re-run the container's import+serve entrypoint against the new config.
    // `docker restart` handles the common case (container already exists, from
    // a previous cycle or a prior `up`); if it has never been created, fall
    // back to `docker compose up -d` which creates and starts it. Either way a
    // single import runs — never two concurrently.
    let action: "restarted" | "created";
    try {
      await ctx.runner("docker", ["restart", STAGING_CONTAINER_NAME], {
        cwd: ctx.dataDir,
        stdio: "pipe",
      });
      action = "restarted";
    } catch {
      try {
        // Prefer an explicit `-f <composeFile>` so the create path doesn't
        // depend on a compose file in the process cwd (the prod data-manager's
        // cwd has none). Falls back to cwd-relative resolution when no
        // composeFile is configured (tests / the self-contained canary).
        const composeArgs = ctx.composeFile
          ? ["compose", "-f", ctx.composeFile, "up", "-d", STAGING_CONTAINER_NAME]
          : ["compose", "up", "-d", STAGING_CONTAINER_NAME];
        await ctx.runner("docker", composeArgs, {
          cwd: ctx.dataDir,
          stdio: "pipe",
        });
        action = "created";
      } catch (error) {
        const err = error as Error;
        return {
          stage: "motis-import",
          status: "error",
          startedAt,
          finishedAt: ctx.now(),
          durationMs: Date.now() - start,
          message: `failed to start ${STAGING_CONTAINER_NAME}: ${err.message}`,
          error: { message: err.message, stack: err.stack },
        } satisfies StageResult;
      }
    }

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

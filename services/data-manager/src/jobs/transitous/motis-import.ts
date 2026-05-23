import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IMPORT_MARKER_FILE } from "./internal.js";
import type { StageFn, StageResult } from "./types.js";

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes for a planet-scale import

const STAGING_CONTAINER_NAME = "motis-staging";
const STAGING_CONFIG_PATH = "/motis-data/config.yml";

function parseTimeoutMs(): number {
  const raw = process.env.MOTIS_IMPORT_TIMEOUT_MS;
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_TIMEOUT_MS;
  return value;
}

/**
 * Spawn `motis import` inside the staging container against the freshly-rendered
 * `out/config.yml` placed on the staging data volume. The compose generator
 * already wires the staging volume; we only need to ensure the container is up
 * and then `docker exec` into it.
 *
 * The data-manager container intentionally has the host docker socket mounted
 * (see app-api bind mount for the same `@docker-socket` pattern). When running
 * outside a container — local dev, tests with a mock runner — the runner just
 * receives the same args.
 *
 * On timeout / non-zero exit the stage returns `status: "error"` with a short
 * stderr/stdout tail so operators can diagnose without scraping container logs.
 */
export const run: StageFn = async (ctx) => {
  const startedAt = ctx.now();
  const start = Date.now();
  const timeoutMs = parseTimeoutMs();

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

    // Ensure the staging container is running. `docker compose up -d` is
    // idempotent — if the operator hasn't included motis-staging in their
    // service selection, this will fail and we surface a useful error.
    try {
      await ctx.runner("docker", ["compose", "up", "-d", STAGING_CONTAINER_NAME], {
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
        message: `failed to start ${STAGING_CONTAINER_NAME}: ${err.message}`,
        error: { message: err.message, stack: err.stack },
      } satisfies StageResult;
    }

    // Run the actual import. Timeout is enforced via Promise.race; the underlying
    // runner is responsible for cleaning up the spawned docker process when the
    // promise it returns rejects.
    const importDeadline = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => {
        clearTimeout(timer);
        reject(new Error(`motis import timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      // Avoid blocking process exit when the runner resolves first.
      if (typeof timer.unref === "function") timer.unref();
    });

    await Promise.race([
      ctx.runner(
        "docker",
        ["exec", STAGING_CONTAINER_NAME, "/motis", "import", "-c", STAGING_CONFIG_PATH],
        { cwd: ctx.dataDir, stdio: "pipe" },
      ),
      importDeadline,
    ]);

    const durationMs = Date.now() - start;
    // Drop a small marker file the promote stage uses as the strong signal
    // that this staging volume is import-shaped. Best-effort: if the write
    // fails (read-only mount, race with restart) we still return ok and let
    // promote fall through to its MOTIS-file sentinel check.
    const finishedAt = ctx.now();
    try {
      writeFileSync(
        join(ctx.motisStagingDataDir, IMPORT_MARKER_FILE),
        `${JSON.stringify(
          {
            finishedAt,
            importDurationMs: durationMs,
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
      message: `motis import completed against ${STAGING_CONTAINER_NAME}`,
      artifacts: {
        importDurationMs: durationMs,
        configPath: STAGING_CONFIG_PATH,
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

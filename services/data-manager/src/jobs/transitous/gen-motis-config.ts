import { existsSync } from "node:fs";
import { join } from "node:path";
import type { StageFn, StageResult } from "./types.js";

/**
 * Run Transitous's `src/generate-motis-config.py --import-only`. Writes the
 * import-time config under the catalog working tree; downstream MOTIS-import
 * stages read it as input. Skipped when the catalog doesn't ship the script
 * (older revisions, fixture catalogs in tests).
 */
export const run: StageFn = async (ctx) => {
  const startedAt = ctx.now();
  const start = Date.now();
  try {
    const catalogDir = ctx.state.catalogDir ?? ctx.catalogDir;
    const scriptPath = join(catalogDir, "src", "generate-motis-config.py");
    if (!existsSync(scriptPath)) {
      return {
        stage: "gen-motis-config",
        status: "skipped",
        startedAt,
        finishedAt: ctx.now(),
        durationMs: Date.now() - start,
        message: `generate-motis-config.py not present at ${scriptPath}`,
      } satisfies StageResult;
    }
    await ctx.runner("python3", ["./src/generate-motis-config.py", "--import-only"], {
      cwd: catalogDir,
      stdio: "pipe",
    });
    const configPath = join(catalogDir, "out", "config.yml");
    return {
      stage: "gen-motis-config",
      status: "ok",
      startedAt,
      finishedAt: ctx.now(),
      durationMs: Date.now() - start,
      message: "Generated MOTIS import-only config",
      artifacts: {
        configPath,
      },
    };
  } catch (error) {
    const err = error as Error;
    return {
      stage: "gen-motis-config",
      status: "error",
      startedAt,
      finishedAt: ctx.now(),
      durationMs: Date.now() - start,
      message: err.message,
      error: { message: err.message, stack: err.stack },
    };
  }
};

import { existsSync } from "node:fs";
import { join } from "node:path";
import { applyConfigOverrides } from "./config-overrides.js";
import type { StageFn, StageResult } from "./types.js";

/**
 * Run Transitous's `src/generate-motis-config.py --import-only`. Writes the
 * import-time config under the catalog working tree; downstream MOTIS-import
 * stages read it as input. Skipped when the catalog doesn't ship the script
 * (older revisions, fixture catalogs in tests).
 *
 * The generated config is then post-processed by {@link applyConfigOverrides}
 * (osm region, RT, elevators, osr_footpath). The exact same overrides run in
 * `gen-full-config` so the import-only and runtime configs never diverge.
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
    // Pass the configured countries as region args. Without them the upstream
    // script globs ALL ~120 feed files (every country), tries to resolve feeds
    // it never fetched, and fails to emit a usable config; scoping it to the
    // build's countries makes it produce a clean per-region config. Empty
    // countries → no region arg → all regions (a global deployment).
    // `--skip-missing-files` drops feeds whose GTFS didn't fetch this cycle so a
    // single feed failure degrades the build instead of breaking the MOTIS import.
    await ctx.runScript({
      script: "generate-motis-config",
      importOnly: true,
      feedProxy: false,
      countries: ctx.countries,
    });
    const configPath = join(catalogDir, "out", "config.yml");
    const overrides = applyConfigOverrides(configPath, ctx.logger);
    return {
      stage: "gen-motis-config",
      status: "ok",
      startedAt,
      finishedAt: ctx.now(),
      durationMs: Date.now() - start,
      message: "Generated MOTIS import-only config",
      artifacts: {
        configPath,
        ...overrides,
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

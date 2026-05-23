import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JobLogger, StageFn, StageResult } from "./types.js";

/**
 * Post-process the generated `config.yml` to flip MOTIS's
 * `incremental_rt_update` flag when the operator opts in via
 * `MOTIS_INCREMENTAL_RT_UPDATE=true`.
 *
 * Upstream Transitous templates the flag as `false` (each RT poll re-applies
 * the full feed against a clean slate). Setting it to `true` preserves the
 * accumulated RT state between polls — lower CPU per cycle but risks
 * carrying stale entities that the upstream feed silently drops. We keep
 * Transitous's default and only honour the override when an operator
 * explicitly sets the env var; otherwise we don't mutate the file at all.
 *
 * Returns `true` iff the file was modified.
 */
function applyIncrementalRtOverride(configPath: string, logger: JobLogger): boolean {
  const raw = process.env.MOTIS_INCREMENTAL_RT_UPDATE;
  if (raw === undefined) return false;
  const truthy = ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
  const falsy = ["0", "false", "no", "off"].includes(raw.trim().toLowerCase());
  if (!truthy && !falsy) {
    logger.warn(
      `gen-motis-config: ignoring MOTIS_INCREMENTAL_RT_UPDATE=${raw} (expected true/false)`,
    );
    return false;
  }
  if (!existsSync(configPath)) return false;
  let text: string;
  try {
    text = readFileSync(configPath, "utf-8");
  } catch (error) {
    logger.warn(
      `gen-motis-config: could not read ${configPath} to apply incremental_rt_update override: ${(error as Error).message}`,
    );
    return false;
  }
  const desired = truthy ? "true" : "false";
  // Indented YAML scalar inside the `timetable:` block; the upstream template
  // emits it at two-space indent.
  const re = /^(\s*incremental_rt_update:\s*)(true|false)\s*$/m;
  const match = text.match(re);
  if (!match) {
    logger.warn(
      `gen-motis-config: incremental_rt_update key not found in ${configPath}; override skipped`,
    );
    return false;
  }
  if (match[2] === desired) return false;
  const next = text.replace(re, `$1${desired}`);
  try {
    writeFileSync(configPath, next, "utf-8");
    logger.info(
      `gen-motis-config: incremental_rt_update set to ${desired} via MOTIS_INCREMENTAL_RT_UPDATE`,
    );
    return true;
  } catch (error) {
    logger.warn(
      `gen-motis-config: could not write incremental_rt_update override to ${configPath}: ${(error as Error).message}`,
    );
    return false;
  }
}

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
    const incrementalRtOverridden = applyIncrementalRtOverride(configPath, ctx.logger);
    return {
      stage: "gen-motis-config",
      status: "ok",
      startedAt,
      finishedAt: ctx.now(),
      durationMs: Date.now() - start,
      message: "Generated MOTIS import-only config",
      artifacts: {
        configPath,
        incrementalRtOverridden,
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

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { StageFn, StageResult } from "./types.js";

/**
 * Run Transitous's `src/generate-attribution.py`, which writes the consolidated
 * per-feed attribution/licensing manifest to `out/license.json`. We assert that
 * file exists afterwards and count its entries — a missing file is a hard stage
 * error rather than a silently-empty success (the old code looked for the wrong
 * filenames and reported `ok` with 0 entries forever).
 */
export const run: StageFn = async (ctx) => {
  const startedAt = ctx.now();
  const start = Date.now();
  try {
    const catalogDir = ctx.state.catalogDir ?? ctx.catalogDir;
    const scriptPath = join(catalogDir, "src", "generate-attribution.py");
    if (!existsSync(scriptPath)) {
      const configPath = join(catalogDir, "out", "config.yml");
      return {
        stage: "gen-attribution",
        // A deliberately partial dev/test catalog has no candidate at all.
        // Once a config exists, however, attribution is part of the immutable
        // tuple and must fail closed.
        status: existsSync(configPath) ? "error" : "skipped",
        startedAt,
        finishedAt: ctx.now(),
        durationMs: Date.now() - start,
        message: existsSync(configPath)
          ? `generate-attribution.py not present at ${scriptPath}; candidate attribution is required`
          : `generate-attribution.py not present at ${scriptPath}; no candidate config was generated`,
      } satisfies StageResult;
    }
    await ctx.runner("python3", ["./src/generate-attribution.py"], {
      cwd: catalogDir,
      stdio: "pipe",
    });

    const attributionFilePath = join(catalogDir, "out", "license.json");
    if (!existsSync(attributionFilePath)) {
      throw new Error(
        `generate-attribution.py did not produce ${attributionFilePath} — attribution data is missing`,
      );
    }

    let licenseEntries = 0;
    try {
      const parsed = JSON.parse(readFileSync(attributionFilePath, "utf-8")) as unknown;
      if (Array.isArray(parsed)) licenseEntries = parsed.length;
      else if (parsed && typeof parsed === "object") {
        licenseEntries = Object.keys(parsed as Record<string, unknown>).length;
      }
    } catch {
      // Tolerate a malformed file — the file exists, so the stage still ran.
    }

    return {
      stage: "gen-attribution",
      status: "ok",
      startedAt,
      finishedAt: ctx.now(),
      durationMs: Date.now() - start,
      message: `Generated attribution file (${licenseEntries} entries)`,
      artifacts: {
        licenseEntries,
        attributionFilePath,
      },
    };
  } catch (error) {
    const err = error as Error;
    return {
      stage: "gen-attribution",
      status: "error",
      startedAt,
      finishedAt: ctx.now(),
      durationMs: Date.now() - start,
      message: err.message,
      error: { message: err.message, stack: err.stack },
    };
  }
};

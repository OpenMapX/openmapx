import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { StageFn, StageResult } from "./types.js";

/**
 * Run Transitous's `src/generate-attribution.py` to produce the operator-
 * facing license/attribution file. Counts license entries when the produced
 * file is JSON; otherwise reports the file size as a coarse signal.
 */
export const run: StageFn = async (ctx) => {
  const startedAt = ctx.now();
  const start = Date.now();
  try {
    const catalogDir = ctx.state.catalogDir ?? ctx.catalogDir;
    const scriptPath = join(catalogDir, "src", "generate-attribution.py");
    if (!existsSync(scriptPath)) {
      return {
        stage: "gen-attribution",
        status: "skipped",
        startedAt,
        finishedAt: ctx.now(),
        durationMs: Date.now() - start,
        message: `generate-attribution.py not present at ${scriptPath}`,
      } satisfies StageResult;
    }
    await ctx.runner("python3", ["./src/generate-attribution.py"], {
      cwd: catalogDir,
      stdio: "pipe",
    });

    // Transitous writes the attribution under `out/attributions.json` (newer
    // revisions) or `out/attribution.html` (older). Best-effort detect both.
    const candidates = [
      join(catalogDir, "out", "attributions.json"),
      join(catalogDir, "out", "attribution.html"),
    ];
    const attributionFilePath = candidates.find((path) => existsSync(path)) ?? candidates[0];

    let licenseEntries = 0;
    if (attributionFilePath?.endsWith(".json") && existsSync(attributionFilePath)) {
      try {
        const parsed = JSON.parse(readFileSync(attributionFilePath, "utf-8")) as unknown;
        if (Array.isArray(parsed)) licenseEntries = parsed.length;
        else if (parsed && typeof parsed === "object") {
          licenseEntries = Object.keys(parsed as Record<string, unknown>).length;
        }
      } catch {
        // Tolerate a malformed file — the stage still succeeded.
      }
    } else if (attributionFilePath && existsSync(attributionFilePath)) {
      // For HTML output we have no cheap entry count; fall back to byte size.
      licenseEntries = statSync(attributionFilePath).size;
    }

    return {
      stage: "gen-attribution",
      status: "ok",
      startedAt,
      finishedAt: ctx.now(),
      durationMs: Date.now() - start,
      message: "Generated attribution file",
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

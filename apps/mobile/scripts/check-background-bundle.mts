#!/usr/bin/env node
/**
 * Bundles the real background entry with Metro and asserts its dependency
 * graph.
 *
 * This deliberately uses the same bundler the app ships with rather than a
 * stand-in: an import that Metro resolves differently from esbuild is exactly
 * the kind of thing that would otherwise reach a device.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeBackgroundBundle } from "./backgroundBundlePolicy.ts";

const mobileRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = "src/background/defineNavigationTask.ts";

function main(): number {
  const workDir = mkdtempSync(join(tmpdir(), "openmapx-bg-bundle-"));
  const bundlePath = join(workDir, "background.js");
  const sourcemapPath = join(workDir, "background.map");
  try {
    execFileSync(
      "npx",
      [
        "--no-install",
        "expo",
        "export:embed",
        "--entry-file",
        ENTRY,
        "--platform",
        "ios",
        "--dev",
        "false",
        "--bundle-output",
        bundlePath,
        "--sourcemap-output",
        sourcemapPath,
      ],
      { cwd: mobileRoot, stdio: "inherit" },
    );

    const sourceMap = JSON.parse(readFileSync(sourcemapPath, "utf8")) as { sources: string[] };
    const report = analyzeBackgroundBundle({
      sources: sourceMap.sources,
      code: readFileSync(bundlePath, "utf8"),
      byteLength: statSync(bundlePath).size,
    });

    console.log(`\n[mobile:bundle:check] entry: ${ENTRY}`);
    console.log(`[mobile:bundle:check] modules: ${report.moduleCount}`);
    console.log(`[mobile:bundle:check] bundle size: ${(report.byteLength / 1024).toFixed(1)} KiB`);
    console.log(`[mobile:bundle:check] React runtimes: ${report.reactRuntimeVersions.join(", ")}`);
    console.log(`[mobile:bundle:check] workspace modules: ${report.workspaceModules.length}`);
    for (const module of report.workspaceModules) console.log(`    ${module}`);

    if (report.failures.length > 0) {
      console.error(
        `\n[mobile:bundle:check] ${report.failures.length} forbidden dependency issue(s)`,
      );
      for (const failure of report.failures) console.error(`  - ${failure}`);
      return 1;
    }
    console.log("\n[mobile:bundle:check] the background graph is headless-safe");
    return 0;
  } catch (error) {
    console.error(`\n[mobile:bundle:check] ${(error as Error).message}`);
    return 1;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

process.exitCode = main();

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run as genAttributionRun } from "../../src/jobs/transitous/gen-attribution.js";
import { buildJobContext } from "../../src/jobs/transitous/pipeline.js";
import type { TransitousScriptRunner } from "../../src/jobs/transitous/script-runner.js";
import { StateStore } from "../../src/state.js";

let tmp: string | undefined;

afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  }
});

function setupCatalog(withScript = true): { dataDir: string; catalogDir: string; outDir: string } {
  tmp = mkdtempSync(join(tmpdir(), "openmapx-gen-attribution-"));
  const catalogDir = join(tmp, ".transitous-catalog");
  const outDir = join(catalogDir, "out");
  mkdirSync(join(catalogDir, "src"), { recursive: true });
  mkdirSync(outDir, { recursive: true });
  if (withScript) writeFileSync(join(catalogDir, "src", "generate-attribution.py"), "");
  return { dataDir: tmp, catalogDir, outDir };
}

function ctxFor(dataDir: string, catalogDir: string, runScript: TransitousScriptRunner) {
  const ctx = buildJobContext({
    dataDir,
    store: new StateStore(dataDir),
    runScript,
    now: () => "2026-05-01T00:00:00.000Z",
  });
  ctx.state.catalogDir = catalogDir;
  return ctx;
}

describe("gen-attribution", () => {
  it("counts entries from out/license.json (the real upstream output path)", async () => {
    const fx = setupCatalog();
    // Simulate generate-attribution.py writing its manifest.
    const runScript: TransitousScriptRunner = async () => {
      writeFileSync(
        join(fx.outDir, "license.json"),
        JSON.stringify([{ source: "a" }, { source: "b" }, { source: "c" }]),
      );
    };
    const result = await genAttributionRun(ctxFor(fx.dataDir, fx.catalogDir, runScript));
    expect(result.status).toBe("ok");
    expect(result.artifacts).toMatchObject({ licenseEntries: 3 });
    expect(String(result.artifacts?.attributionFilePath)).toMatch(/out\/license\.json$/);
  });

  it("errors loudly when the script produced no license.json (no silent empty success)", async () => {
    const fx = setupCatalog();
    const runScript: TransitousScriptRunner = async () => {
      /* script ran but wrote nothing */
    };
    const result = await genAttributionRun(ctxFor(fx.dataDir, fx.catalogDir, runScript));
    expect(result.status).toBe("error");
    expect(result.message).toMatch(/did not produce/i);
  });

  it("fails closed when the catalog ships no generate-attribution.py", async () => {
    const fx = setupCatalog(false);
    writeFileSync(join(fx.outDir, "config.yml"), "timetable: {}\n");
    const result = await genAttributionRun(ctxFor(fx.dataDir, fx.catalogDir, async () => {}));
    expect(result.status).toBe("error");
    expect(result.message).toContain("candidate attribution is required");
  });
});

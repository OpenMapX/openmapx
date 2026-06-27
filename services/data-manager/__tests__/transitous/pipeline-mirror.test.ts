import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildJobContext,
  runTransitousPipeline,
  stagesFor,
} from "../../src/jobs/transitous/pipeline.js";
import type { StageResult } from "../../src/jobs/transitous/types.js";
import { StateStore } from "../../src/state.js";

let tmp: string | undefined;

afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  }
});

describe("stagesFor", () => {
  const BUILD = [
    "prepare",
    "filter",
    "fetch",
    "validate",
    "gen-motis-config",
    "assemble-staging",
    "motis-import",
    "motis-health",
    "gen-full-config",
    "gen-attribution",
    "promote",
    "gc",
  ];

  it("selects the build pipeline for source=build", () => {
    expect(stagesFor("build").map((s) => s.name)).toEqual(BUILD);
  });

  it("selects the mirror pipeline (build with fetch -> mirror) for source=mirror", () => {
    expect(stagesFor("mirror").map((s) => s.name)).toEqual(
      BUILD.map((n) => (n === "fetch" ? "mirror" : n)),
    );
  });
});

describe("mirror-mode pipeline", () => {
  it("downloads cleaned archives in place of fetch.py", async () => {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-pipeline-mirror-"));
    const dataDir = tmp;
    const catalogDir = join(dataDir, ".transitous-catalog");
    const gtfsDir = join(dataDir, "gtfs");
    mkdirSync(join(catalogDir, ".git"), { recursive: true });
    mkdirSync(join(catalogDir, "feeds"), { recursive: true });
    mkdirSync(join(catalogDir, "src"), { recursive: true });
    writeFileSync(
      join(catalogDir, "feeds", "de.json"),
      JSON.stringify({ sources: [{ name: "BVG" }] }),
    );
    writeFileSync(join(catalogDir, "src", "generate-motis-config.py"), "#!/usr/bin/env python3\n");

    let wgetArgs: string[] | undefined;
    const persisted: StageResult[] = [];
    const ctx = buildJobContext({
      dataDir,
      store: new StateStore(dataDir),
      countries: ["de"],
      source: "mirror",
      runner: async (command, args) => {
        if (command === "wget") {
          wgetArgs = args;
          // Simulate the published cleaned archive landing in the gtfs dir.
          mkdirSync(gtfsDir, { recursive: true });
          writeFileSync(join(gtfsDir, "de_BVG.gtfs.zip"), "BVG");
        }
        // python3 (filter's resolution pre-check) + everything else: no-op.
      },
      now: () => "2026-06-27T00:00:00.000Z",
      onStageComplete: async (r) => {
        persisted.push(r);
      },
    });

    // Stop after `mirror` to avoid the docker/import tail (covered elsewhere).
    const { results } = await runTransitousPipeline(ctx, { stopAt: "mirror" });

    expect(results.map((r) => r.stage)).toEqual(["prepare", "filter", "mirror"]);
    const mirror = results.find((r) => r.stage === "mirror");
    expect(mirror?.status).toBe("ok");
    // It wgetted (a recursive archive mirror), not ran fetch.py.
    expect(wgetArgs).toContain("--recursive");
    expect(existsSync(join(gtfsDir, "de_BVG.gtfs.zip"))).toBe(true);
  });
});

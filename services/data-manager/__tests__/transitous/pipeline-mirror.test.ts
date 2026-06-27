import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  it("selects the build pipeline for source=build", () => {
    expect(stagesFor("build").map((s) => s.name)).toEqual([
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
    ]);
  });

  it("selects the mirror pipeline for source=mirror", () => {
    expect(stagesFor("mirror").map((s) => s.name)).toEqual([
      "prepare",
      "mirror",
      "mirror-config",
      "assemble-staging",
      "motis-import",
      "motis-health",
      "promote",
    ]);
  });
});

describe("mirror-mode pipeline", () => {
  it("downloads artifacts and repoints realtime onto our feed-proxy", async () => {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-pipeline-mirror-"));
    const dataDir = tmp;
    const catalogDir = join(dataDir, ".transitous-catalog");
    const gtfsDir = join(dataDir, "gtfs");
    mkdirSync(join(catalogDir, ".git"), { recursive: true });
    mkdirSync(join(catalogDir, "feeds"), { recursive: true });
    mkdirSync(join(catalogDir, "src"), { recursive: true });
    writeFileSync(join(catalogDir, "src", "generate-motis-config.py"), "#!/usr/bin/env python3\n");

    const persisted: StageResult[] = [];
    const ctx = buildJobContext({
      dataDir,
      store: new StateStore(dataDir),
      countries: [],
      source: "mirror",
      feedProxyUrl: "http://test-feed-proxy",
      runner: async (command, args) => {
        // Simulate `wget` writing the published config + license into out/.
        if (command === "wget" && args.includes("-O")) {
          const target = args[args.indexOf("-O") + 1];
          if (typeof target === "string" && target.endsWith("config.yml")) {
            writeFileSync(
              target,
              "osm: planet-latest.osm.pbf\ntimetable:\n  datasets:\n    de-bvg:\n      rt:\n        - url: https://rt.triptix.tech/feed/de-bvg-0\n",
            );
          } else if (typeof target === "string" && target.endsWith("license.json")) {
            writeFileSync(target, "[]");
          }
        }
      },
      now: () => "2026-06-27T00:00:00.000Z",
      onStageComplete: async (result) => {
        persisted.push(result);
      },
    });

    const { results } = await runTransitousPipeline(ctx, { stopAt: "mirror-config" });

    expect(results.map((r) => r.stage)).toEqual(["prepare", "mirror", "mirror-config"]);
    const byStage = Object.fromEntries(results.map((r) => [r.stage, r]));
    expect(byStage.prepare?.status).toBe("ok");
    expect(byStage.mirror?.status).toBe("ok");
    expect(byStage["mirror-config"]?.status).toBe("ok");

    // The published config's rt.triptix.tech URL was repointed to our proxy.
    const config = readFileSync(join(gtfsDir, "config.yml"), "utf-8");
    expect(config).toContain("http://test-feed-proxy/feed/de-bvg-0");
    expect(config).not.toContain("rt.triptix.tech");
    expect(byStage["mirror-config"]?.artifacts).toMatchObject({ rtRewritten: 1 });
  });
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildJobContext, runTransitousPipeline } from "../../src/jobs/transitous/pipeline.js";
import type { StageName, StageResult } from "../../src/jobs/transitous/types.js";
import { StateStore } from "../../src/state.js";
import { writeFixtureGtfsArchive } from "../helpers/gtfs-fixture.js";

// Preparation fails closed without a pinned catalog commit. The lock is
// agent-owned now, so the pin is supplied through the typed operation.
const PINNED_LOCK = {
  ref: `main@${"a".repeat(40)}`,
  submodules: {},
  lockedAt: "2026-04-20T12:00:00.000Z",
  lockedBy: "test",
};
vi.mock("../../src/ops-client.js", () => ({
  runOpsOperation: vi.fn(async (operation: { kind: string }) => {
    if (operation.kind === "transitousLock.inspect") {
      return { active: PINNED_LOCK, proposed: null };
    }
    if (operation.kind === "gbfsCatalogLock.inspect") {
      return {
        commit: "b".repeat(40),
        url: "https://example.test/catalog.csv",
        sha256: "c".repeat(64),
        lockedAt: "2026-04-20T12:00:00.000Z",
        lockedBy: "test",
      };
    }
    return { changed: true };
  }),
}));

let tmp: string | undefined;

afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  }
});

const ORDERED_STAGES: StageName[] = [
  "prepare",
  "filter",
  "preflight",
  "compile-gbfs",
  "fetch",
  "validate",
  "gen-full-config",
  "gen-attribution",
  "assemble-staging",
  "motis-import",
  "motis-health",
  "promote",
  "gc",
];

describe("runTransitousPipeline orchestrator", () => {
  it("invokes all stages in order against an in-memory persistence hook", async () => {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-pipeline-orchestrator-"));
    const dataDir = tmp;
    const catalogDir = join(dataDir, ".transitous-catalog");
    const gtfsDir = join(dataDir, "gtfs");
    mkdirSync(join(catalogDir, ".git"), { recursive: true });
    mkdirSync(join(catalogDir, "feeds"), { recursive: true });
    mkdirSync(join(catalogDir, "src"), { recursive: true });
    writeFileSync(
      join(catalogDir, "feeds", "de.json"),
      JSON.stringify({ sources: [{ name: "BVG" }] }, null, 2),
    );
    // Stub Transitous python scripts so the gen-* stages dispatch their run.
    writeFileSync(join(catalogDir, "src", "generate-motis-config.py"), "#!/usr/bin/env python3\n");
    writeFileSync(join(catalogDir, "src", "generate-attribution.py"), "#!/usr/bin/env python3\n");
    writeFileSync(join(catalogDir, "src", "garbage-collect.py"), "#!/usr/bin/env python3\n");

    const persisted: StageResult[] = [];

    const ctx = buildJobContext({
      dataDir,
      store: new StateStore(dataDir),
      countries: ["de"],
      runner: async () => {},
      runScript: async (run) => {
        if (run.script === "fetch") {
          writeFixtureGtfsArchive(join(gtfsDir, "de_bvg.gtfs.zip"));
        } else if (run.script === "generate-motis-config" && !run.feedProxy) {
          writeFileSync(
            join(catalogDir, "out", "config.yml"),
            "timetable:\n  datasets:\n    de_bvg:\n      path: de_bvg.gtfs.zip\n",
          );
        } else if (run.script === "feed-proxy-vars-to-json") {
          writeFileSync(join(catalogDir, "out", "feed-proxy-vars.json"), "{}");
        } else if (run.script === "generate-attribution") {
          // Simulate the upstream script writing its manifest (gen-attribution
          // now asserts the file exists).
          writeFileSync(join(catalogDir, "out", "license.json"), "[]");
        }
      },
      now: () => "2026-05-01T00:00:00.000Z",
      onStageComplete: async (result) => {
        persisted.push(result);
      },
    });

    const { results, finalStatus } = await runTransitousPipeline(ctx, {
      stopAt: "assemble-staging",
    });

    const throughAssembly = ORDERED_STAGES.slice(0, ORDERED_STAGES.indexOf("assemble-staging") + 1);
    expect(results.map((r) => r.stage)).toEqual(throughAssembly);
    expect(persisted.map((r) => r.stage)).toEqual(throughAssembly);

    // The finalized config and attribution are assembled before any import.
    const byStage = Object.fromEntries(results.map((r) => [r.stage, r]));
    expect(byStage["assemble-staging"]?.status).toBe("ok");
    expect(byStage["motis-import"]).toBeUndefined();
    expect(byStage["motis-health"]).toBeUndefined();
    expect(byStage.promote).toBeUndefined();

    // Non-stub stages all returned ok against the fixture.
    expect(byStage.prepare?.status).toBe("ok");
    expect(byStage.filter?.status).toBe("ok");
    expect(byStage.fetch?.status).toBe("ok");
    expect(byStage.gc).toBeUndefined();
    expect(finalStatus).toBe("ok");
  });

  it("rethrows the underlying error when a hard-stop stage fails", async () => {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-pipeline-hardstop-"));
    const dataDir = tmp;
    const catalogDir = join(dataDir, ".transitous-catalog");
    mkdirSync(join(catalogDir, ".git"), { recursive: true });
    mkdirSync(join(catalogDir, "feeds"), { recursive: true });
    writeFileSync(
      join(catalogDir, "feeds", "de.json"),
      JSON.stringify({ sources: [{ name: "BVG" }] }, null, 2),
    );

    const persisted: StageResult[] = [];
    const ctx = buildJobContext({
      dataDir,
      store: new StateStore(dataDir),
      countries: ["zz"],
      runner: async () => {},
      runScript: async () => {},
      now: () => "2026-05-01T00:00:00.000Z",
      onStageComplete: async (result) => {
        persisted.push(result);
      },
    });

    await expect(runTransitousPipeline(ctx)).rejects.toThrow(
      /does not contain any feed files for countries: zz/,
    );

    // prepare ran ok; filter errored hard-stop; nothing after filter ran.
    expect(persisted.map((r) => r.stage)).toEqual(["prepare", "filter"]);
    expect(persisted[1]?.status).toBe("error");
  });

  it("runs end-to-end on a seeded 3-feed catalog within a 60s wall-clock budget", async () => {
    // A seeded fake transitous-catalog with multiple feeds across two regions;
    // the pipeline runs every stage in order (stubs included) and finishes
    // under 60s.
    //
    // A "real MOTIS container in CI" variant (where motis-import / motis-health
    // / promote actually run against a running staging container with a tiny
    // GTFS fixture imported) lives in pipeline-live-motis.test.ts, gated by
    // OPENMAPX_E9_LIVE_MOTIS=true so it doesn't run in the default suite.
    tmp = mkdtempSync(join(tmpdir(), "openmapx-pipeline-multi-feed-"));
    const dataDir = tmp;
    const catalogDir = join(dataDir, ".transitous-catalog");
    const gtfsDir = join(dataDir, "gtfs");
    mkdirSync(join(catalogDir, ".git"), { recursive: true });
    mkdirSync(join(catalogDir, "feeds"), { recursive: true });
    mkdirSync(join(catalogDir, "src"), { recursive: true });
    writeFileSync(
      join(catalogDir, "feeds", "de.json"),
      JSON.stringify({ sources: [{ name: "BVG" }, { name: "DELFI" }] }, null, 2),
    );
    writeFileSync(
      join(catalogDir, "feeds", "ch.json"),
      JSON.stringify({ sources: [{ name: "SBB" }] }, null, 2),
    );
    writeFileSync(join(catalogDir, "src", "generate-motis-config.py"), "#!/usr/bin/env python3\n");
    writeFileSync(join(catalogDir, "src", "generate-attribution.py"), "#!/usr/bin/env python3\n");
    writeFileSync(join(catalogDir, "src", "garbage-collect.py"), "#!/usr/bin/env python3\n");

    const ctx = buildJobContext({
      dataDir,
      store: new StateStore(dataDir),
      countries: ["de", "ch"],
      runner: async () => {},
      runScript: async (run) => {
        if (run.script === "fetch") {
          mkdirSync(gtfsDir, { recursive: true });
          writeFixtureGtfsArchive(join(gtfsDir, "de_bvg.gtfs.zip"));
          writeFixtureGtfsArchive(join(gtfsDir, "de_delfi.gtfs.zip"));
          writeFixtureGtfsArchive(join(gtfsDir, "ch_sbb.gtfs.zip"));
        } else if (run.script === "generate-attribution") {
          writeFileSync(join(catalogDir, "out", "license.json"), "[]");
        }
      },
      now: () => "2026-05-01T00:00:00.000Z",
    });

    const startedAt = Date.now();
    const { results, finalStatus } = await runTransitousPipeline(ctx, { stopAt: "fetch" });
    const elapsedMs = Date.now() - startedAt;

    expect(results.map((r) => r.stage)).toEqual([
      "prepare",
      "filter",
      "preflight",
      "compile-gbfs",
      "fetch",
    ]);
    expect(finalStatus).toBe("ok");
    expect(elapsedMs).toBeLessThan(60_000);
  });

  it("rejects a build candidate when even one desired source fetch fails", async () => {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-pipeline-partial-"));
    const dataDir = tmp;
    const catalogDir = join(dataDir, ".transitous-catalog");
    const gtfsDir = join(dataDir, "gtfs");
    mkdirSync(join(catalogDir, ".git"), { recursive: true });
    mkdirSync(join(catalogDir, "feeds"), { recursive: true });
    writeFileSync(
      join(catalogDir, "feeds", "de.json"),
      JSON.stringify({ sources: [{ name: "A" }, { name: "B" }] }, null, 2),
    );

    const ctx = buildJobContext({
      dataDir,
      store: new StateStore(dataDir),
      countries: ["de"],
      runner: async () => {},
      runScript: async (run) => {
        if (run.script === "fetch") {
          // Partial fetch: write A, then error attributable to B.
          mkdirSync(gtfsDir, { recursive: true });
          writeFixtureGtfsArchive(join(gtfsDir, "de_a.gtfs.zip"));
          throw new Error("Error: Could not fetch de-B: HTTP 500");
        }
      },
      now: () => "2026-05-01T00:00:00.000Z",
    });

    await expect(runTransitousPipeline(ctx, { stopAt: "fetch" })).rejects.toThrow(
      /Fetched 1\/2 feed source/,
    );
  });
});

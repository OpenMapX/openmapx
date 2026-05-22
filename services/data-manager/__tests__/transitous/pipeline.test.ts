import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildJobContext, runTransitousPipeline } from "../../src/jobs/transitous/pipeline.js";
import type { StageName, StageResult } from "../../src/jobs/transitous/types.js";
import { StateStore } from "../../src/state.js";

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
  "fetch",
  "validate",
  "gen-motis-config",
  "motis-import",
  "motis-health",
  "gen-full-config",
  "gen-attribution",
  "promote",
  "gc",
];

describe("runTransitousPipeline orchestrator", () => {
  it("invokes all 11 stages in order against an in-memory persistence hook", async () => {
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
    // Stub Transitous python scripts so gen-* stages run their python3 line.
    writeFileSync(join(catalogDir, "src", "generate-motis-config.py"), "#!/usr/bin/env python3\n");
    writeFileSync(join(catalogDir, "src", "generate-attribution.py"), "#!/usr/bin/env python3\n");
    writeFileSync(join(catalogDir, "src", "garbage-collect.py"), "#!/usr/bin/env python3\n");

    const persisted: StageResult[] = [];

    const ctx = buildJobContext({
      dataDir,
      store: new StateStore(dataDir),
      countries: ["de"],
      runner: async (command, args) => {
        if (command === "python3" && args[0] === "./src/fetch.py") {
          writeFileSync(join(gtfsDir, "de_bvg.gtfs.zip"), "BVG");
        }
      },
      now: () => "2026-05-01T00:00:00.000Z",
      onStageComplete: async (result) => {
        persisted.push(result);
      },
    });

    const { results, finalStatus } = await runTransitousPipeline(ctx);

    expect(results.map((r) => r.stage)).toEqual(ORDERED_STAGES);
    expect(persisted.map((r) => r.stage)).toEqual(ORDERED_STAGES);

    // Stub stages always come back skipped.
    const byStage = Object.fromEntries(results.map((r) => [r.stage, r]));
    expect(byStage["motis-import"]?.status).toBe("skipped");
    expect(byStage["motis-health"]?.status).toBe("skipped");
    expect(byStage.promote?.status).toBe("skipped");

    // Non-stub stages all returned ok against the fixture.
    expect(byStage.prepare?.status).toBe("ok");
    expect(byStage.filter?.status).toBe("ok");
    expect(byStage.fetch?.status).toBe("ok");
    expect(byStage.gc?.status).toBe("ok");

    // Aggregate final status ignores skipped, so "ok" overall.
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
    // This is the plan §E9 acceptance: a seeded fake transitous-catalog with
    // multiple feeds across two regions, pipeline runs all 11 stages in order
    // (stubs included), finishes under 60s.
    //
    // A "real MOTIS container in CI" variant (where motis-import / motis-health
    // / promote actually run against a running staging container with a tiny
    // GTFS fixture imported) is intentionally deferred — that requires Docker
    // in the CI runner and a fixture small enough to import in ~10s. Tracked
    // as a Phase E follow-up in docs/INTEGRATIONS.md.
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
      runner: async (command, args) => {
        if (command === "python3" && args[0] === "./src/fetch.py") {
          mkdirSync(gtfsDir, { recursive: true });
          writeFileSync(join(gtfsDir, "de_bvg.gtfs.zip"), "BVG");
          writeFileSync(join(gtfsDir, "de_delfi.gtfs.zip"), "DELFI");
          writeFileSync(join(gtfsDir, "ch_sbb.gtfs.zip"), "SBB");
        }
      },
      now: () => "2026-05-01T00:00:00.000Z",
    });

    const startedAt = Date.now();
    const { results, finalStatus } = await runTransitousPipeline(ctx);
    const elapsedMs = Date.now() - startedAt;

    expect(results.map((r) => r.stage)).toEqual(ORDERED_STAGES);
    expect(finalStatus).toBe("ok");
    expect(elapsedMs).toBeLessThan(60_000);
  });

  it("aggregates final status as partial when a soft-stop stage returns partial", async () => {
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
      runner: async (command, args) => {
        if (command === "python3" && args[0] === "./src/fetch.py") {
          // Partial fetch: write A, then error attributable to B.
          mkdirSync(gtfsDir, { recursive: true });
          writeFileSync(join(gtfsDir, "de_a.gtfs.zip"), "A");
          throw new Error("Error: Could not fetch de-B: HTTP 500");
        }
      },
      now: () => "2026-05-01T00:00:00.000Z",
    });

    const { results, finalStatus } = await runTransitousPipeline(ctx);

    const byStage = Object.fromEntries(results.map((r) => [r.stage, r]));
    expect(byStage.fetch?.status).toBe("partial");
    expect(finalStatus).toBe("partial");
  });
});

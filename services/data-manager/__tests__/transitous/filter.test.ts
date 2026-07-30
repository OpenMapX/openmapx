import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run as filterRun } from "../../src/jobs/transitous/filter.js";
import { buildJobContext } from "../../src/jobs/transitous/pipeline.js";
import type { CommandRunner } from "../../src/jobs/transitous/types.js";
import { StateStore } from "../../src/state.js";

type FeedSource = { name?: string; skip?: boolean; "api-key"?: string };

let tmp: string | undefined;

afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  }
});

function makeCatalog(dataDir: string): string {
  const catalogDir = join(dataDir, ".transitous-catalog");
  mkdirSync(join(catalogDir, "feeds"), { recursive: true });
  return catalogDir;
}

function readSources(feedPath: string): FeedSource[] {
  return (JSON.parse(readFileSync(feedPath, "utf-8")) as { sources: FeedSource[] }).sources;
}

/** Runner that plays out a scripted behaviour per `generate-motis-config.py` run. */
function makeRunner(behaviours: Array<"ok" | string>): {
  runner: CommandRunner;
  state: { calls: number };
} {
  const state = { calls: 0 };
  const runner: CommandRunner = async () => {
    const behaviour = behaviours[Math.min(state.calls, behaviours.length - 1)] ?? "ok";
    state.calls += 1;
    if (behaviour !== "ok") throw Object.assign(new Error(behaviour), { stderr: behaviour });
  };
  return { runner, state };
}

describe("filter stage", () => {
  it("narrows feeds to the requested countries and counts active schedule sources", async () => {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-filter-narrow-"));
    const catalogDir = makeCatalog(tmp);
    writeFileSync(
      join(catalogDir, "feeds", "de.json"),
      JSON.stringify({ sources: [{ name: "BVG" }, { name: "VBB", skip: true }] }, null, 2),
    );
    writeFileSync(
      join(catalogDir, "feeds", "us.json"),
      JSON.stringify({ sources: [{ name: "MBTA" }] }, null, 2),
    );

    const ctx = buildJobContext({
      dataDir: tmp,
      store: new StateStore(tmp),
      countries: ["de"],
      runner: async () => {},
      now: () => "2026-05-01T00:00:00.000Z",
    });
    ctx.state.catalogDir = catalogDir;

    const result = await filterRun(ctx);
    expect(result.status).toBe("ok");
    expect(result.artifacts).toMatchObject({
      activeFeeds: 1,
      requestedCount: 2,
      selectedCount: 1,
      skippedCount: 1,
    });
    expect(ctx.state.selectedFeedFiles?.map((f) => f.id)).toEqual(["de"]);
    expect(ctx.state.expectedFeedIds && Array.from(ctx.state.expectedFeedIds)).toContain("de_bvg");
  });

  it("errors when the catalog has no matching feed files for the requested countries", async () => {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-filter-nomatch-"));
    const catalogDir = makeCatalog(tmp);
    writeFileSync(
      join(catalogDir, "feeds", "de.json"),
      JSON.stringify({ sources: [{ name: "BVG" }] }, null, 2),
    );

    const ctx = buildJobContext({
      dataDir: tmp,
      store: new StateStore(tmp),
      countries: ["zz"],
      runner: async () => {},
      now: () => "2026-05-01T00:00:00.000Z",
    });
    ctx.state.catalogDir = catalogDir;

    const result = await filterRun(ctx);
    expect(result.status).toBe("error");
    expect(result.message).toMatch(/does not contain any feed files for countries: zz/);
  });

  it("pre-skips sources upstream can't resolve and excludes them from the selection", async () => {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-filter-prune-"));
    const catalogDir = makeCatalog(tmp);
    const usFeedPath = join(catalogDir, "feeds", "us.json");
    writeFileSync(
      usFeedPath,
      JSON.stringify({
        sources: [
          { name: "Metra", type: "transitland-atlas", "transitland-atlas-id": "f-metra" },
          { name: "MBTA", type: "transitland-atlas", "transitland-atlas-id": "f-mbta" },
        ],
      }),
    );

    // The resolution pre-check fails once citing Metra, then passes after it's
    // skipped — exactly how the real generate-motis-config.py behaves.
    const { runner, state } = makeRunner(["Error: Could not resolve f-metra", "ok"]);
    const ctx = buildJobContext({
      dataDir: tmp,
      store: new StateStore(tmp),
      countries: ["us"],
      runner,
      now: () => "2026-05-01T00:00:00.000Z",
    });
    ctx.state.catalogDir = catalogDir;

    const result = await filterRun(ctx);
    expect(result.status).toBe("ok");
    expect(result.artifacts?.prunedUnresolvable).toBe(1);
    expect(state.calls).toBe(2);

    const sources = readSources(usFeedPath);
    expect(sources.find((s) => s.name === "Metra")?.skip).toBe(true);
    expect(sources.find((s) => s.name === "MBTA")?.skip).toBeUndefined();

    const expected = ctx.state.expectedFeedIds && Array.from(ctx.state.expectedFeedIds);
    expect(expected).toContain("us_mbta");
    expect(expected).not.toContain("us_metra");
  });

  it("applies feeds-overlay patches to catalog files on disk", async () => {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-filter-overlay-"));
    const catalogDir = makeCatalog(tmp);
    const deFeedPath = join(catalogDir, "feeds", "de.json");
    writeFileSync(
      deFeedPath,
      JSON.stringify(
        {
          sources: [
            { name: "BVG", url: "https://old.example/bvg.zip" },
            { name: "VBB", url: "https://old.example/vbb.zip" },
          ],
        },
        null,
        2,
      ),
    );

    const overlayPath = join(tmp, "feeds-overlay.json");
    writeFileSync(
      overlayPath,
      JSON.stringify(
        {
          version: 3,
          sources: [],
          patches: [
            {
              sourceId: "catalog:de:BVG",
              skip: true,
            },
          ],
          quarantine: [],
        },
        null,
        2,
      ),
    );

    const warnings: string[] = [];
    const infos: string[] = [];
    const ctx = buildJobContext({
      dataDir: tmp,
      store: new StateStore(tmp),
      countries: ["de"],
      feedsOverlayPath: overlayPath,
      runner: async () => {},
      now: () => "2026-05-01T00:00:00.000Z",
      logger: {
        info: (msg) => infos.push(msg),
        warn: (msg) => warnings.push(msg),
        error: () => {},
      },
    });
    ctx.state.catalogDir = catalogDir;

    const result = await filterRun(ctx);
    expect(result.status).toBe("ok");
    expect(result.artifacts?.overlayPatchCount).toBe(1);

    const updated = JSON.parse(readFileSync(deFeedPath, "utf-8")) as {
      sources: Array<Record<string, unknown>>;
    };
    expect(updated.sources[0]).toMatchObject({
      url: "https://old.example/bvg.zip",
      skip: true,
    });
    expect(infos.some((m) => m.includes("applying 1 feeds-overlay patch"))).toBe(true);
  });
});

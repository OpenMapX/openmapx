import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run as filterRun } from "../../src/jobs/transitous/filter.js";
import { buildJobContext } from "../../src/jobs/transitous/pipeline.js";
import { StateStore } from "../../src/state.js";

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

  it("applies feeds-overlay patches to catalog files on disk", async () => {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-filter-overlay-"));
    const catalogDir = makeCatalog(tmp);
    const deFeedPath = join(catalogDir, "feeds", "de.json");
    writeFileSync(
      deFeedPath,
      JSON.stringify({ sources: [{ name: "BVG", url: "https://old.example/bvg.zip" }] }, null, 2),
    );

    const overlayPath = join(tmp, "feeds-overlay.json");
    writeFileSync(
      overlayPath,
      JSON.stringify(
        {
          patches: [
            {
              region: "de",
              name: "BVG",
              patch: { url: "https://new.example/bvg.zip" },
            },
          ],
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
    expect(updated.sources[0]?.url).toBe("https://new.example/bvg.zip");
    expect(infos.some((m) => m.includes("applying 1 feeds-overlay patch"))).toBe(true);
  });
});

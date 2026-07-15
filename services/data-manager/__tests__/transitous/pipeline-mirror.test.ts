import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildJobContext,
  runTransitousPipeline,
  stagePolicyFor,
  stagesFor,
} from "../../src/jobs/transitous/pipeline.js";
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
    "gen-full-config",
    "gen-attribution",
    "assemble-staging",
    "stage-proxy",
    "motis-import",
    "motis-health",
    "promote",
    "gc",
  ];

  it("selects the build pipeline for source=build", () => {
    expect(stagesFor("build").map((s) => s.name)).toEqual(BUILD);
  });

  it("declares every mutation-sensitive stage critical", () => {
    expect(
      Object.fromEntries(stagePolicyFor("build").map((stage) => [stage.name, stage.criticality])),
    ).toMatchObject({
      prepare: "critical",
      filter: "critical",
      validate: "critical",
      "gen-full-config": "critical",
      "gen-attribution": "critical",
      "assemble-staging": "critical",
      "stage-proxy": "critical",
      "motis-import": "critical",
      "motis-health": "critical",
      promote: "critical",
      fetch: "advisory",
      gc: "advisory",
    });
  });

  it("selects the mirror pipeline (build with fetch -> mirror) for source=mirror", () => {
    expect(stagesFor("mirror").map((s) => s.name)).toEqual(
      BUILD.map((n) => (n === "fetch" ? "mirror" : n)),
    );
  });
});

interface MirrorFixture {
  dataDir: string;
  gtfsDir: string;
}

function setupCatalog(sources: Array<Record<string, unknown>>): MirrorFixture {
  tmp = mkdtempSync(join(tmpdir(), "openmapx-pipeline-mirror-"));
  const dataDir = tmp;
  const catalogDir = join(dataDir, ".transitous-catalog");
  mkdirSync(join(catalogDir, ".git"), { recursive: true });
  mkdirSync(join(catalogDir, "feeds"), { recursive: true });
  mkdirSync(join(catalogDir, "src"), { recursive: true });
  writeFileSync(join(catalogDir, "feeds", "de.json"), JSON.stringify({ sources }));
  writeFileSync(join(catalogDir, "src", "generate-motis-config.py"), "#!/usr/bin/env python3\n");
  return { dataDir, gtfsDir: join(dataDir, "gtfs") };
}

describe("mirror-mode pipeline", () => {
  it("downloads each cleaned archive directly by URL in place of fetch.py", async () => {
    const fx = setupCatalog([{ name: "BVG" }]);
    const downloadUrls: string[] = [];
    const ctx = buildJobContext({
      dataDir: fx.dataDir,
      store: new StateStore(fx.dataDir),
      countries: ["de"],
      source: "mirror",
      // filter's resolution pre-check shells out to python3; everything else no-op.
      runner: async () => {},
      artifactDownloader: async (url, dest) => {
        downloadUrls.push(url);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, "BVG");
      },
      now: () => "2026-06-27T00:00:00.000Z",
    });

    // Stop after `mirror` to avoid the docker/import tail (covered elsewhere).
    const { results } = await runTransitousPipeline(ctx, { stopAt: "mirror" });

    expect(results.map((r) => r.stage)).toEqual(["prepare", "filter", "mirror"]);
    expect(results.find((r) => r.stage === "mirror")?.status).toBe("ok");
    // Direct per-file download against the published artifact base, NOT a
    // recursive autoindex crawl.
    expect(downloadUrls).toContain("https://api.transitous.org/gtfs/de_BVG.gtfs.zip");
    expect(existsSync(join(fx.gtfsDir, "de_BVG.gtfs.zip"))).toBe(true);
  });

  it("falls back from gtfs to netex when the gtfs archive 404s", async () => {
    const fx = setupCatalog([{ name: "NX" }]);
    const tried: string[] = [];
    const ctx = buildJobContext({
      dataDir: fx.dataDir,
      store: new StateStore(fx.dataDir),
      countries: ["de"],
      source: "mirror",
      runner: async () => {},
      artifactDownloader: async (url, dest) => {
        tried.push(url);
        if (url.endsWith(".gtfs.zip")) throw new Error("404");
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, "NX");
      },
      now: () => "2026-06-27T00:00:00.000Z",
    });

    const { results } = await runTransitousPipeline(ctx, { stopAt: "mirror" });
    expect(results.find((r) => r.stage === "mirror")?.status).toBe("ok");
    expect(tried).toEqual([
      "https://api.transitous.org/gtfs/de_NX.gtfs.zip",
      "https://api.transitous.org/gtfs/de_NX.netex.zip",
    ]);
    expect(existsSync(join(fx.gtfsDir, "de_NX.netex.zip"))).toBe(true);
  });

  it("reports mirror status 'error' when no archive can be fetched", async () => {
    const fx = setupCatalog([{ name: "BVG" }]);
    const ctx = buildJobContext({
      dataDir: fx.dataDir,
      store: new StateStore(fx.dataDir),
      countries: ["de"],
      source: "mirror",
      runner: async () => {},
      // Every archive download fails (e.g. the published feed is gone).
      artifactDownloader: async () => {
        throw new Error("404");
      },
      now: () => "2026-06-27T00:00:00.000Z",
    });

    // The empty-import guard is at assemble-staging (see assemble-staging tests),
    // not here — mirror just reports the failed acquisition.
    const { results } = await runTransitousPipeline(ctx, { stopAt: "mirror" });
    expect(results.find((r) => r.stage === "mirror")?.status).toBe("error");
  });
});

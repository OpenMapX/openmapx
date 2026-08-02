import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    "preflight",
    "compile-gbfs",
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
      preflight: "critical",
      "compile-gbfs": "critical",
      validate: "critical",
      "gen-full-config": "critical",
      "gen-attribution": "critical",
      "assemble-staging": "critical",
      "stage-proxy": "critical",
      "motis-import": "critical",
      "motis-health": "critical",
      promote: "critical",
      fetch: "critical",
      gc: "advisory",
    });
  });

  it("selects mirror followed by operator acquisition for source=mirror", () => {
    expect(stagesFor("mirror").map((s) => s.name)).toEqual([
      ...BUILD.slice(0, 4),
      "mirror",
      "fetch-operator",
      ...BUILD.slice(5),
    ]);
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

    const { results } = await runTransitousPipeline(ctx, { stopAt: "fetch-operator" });

    expect(results.map((r) => r.stage)).toEqual([
      "prepare",
      "filter",
      "preflight",
      "compile-gbfs",
      "mirror",
      "fetch-operator",
    ]);
    expect(results.find((r) => r.stage === "mirror")?.status).toBe("ok");
    expect(results.find((r) => r.stage === "fetch-operator")?.status).toBe("skipped");
    // Direct per-file download against the published artifact base, NOT a
    // recursive autoindex crawl.
    expect(downloadUrls).toContain("https://api.transitous.org/gtfs/de_BVG.gtfs.zip");
    expect(existsSync(join(fx.gtfsDir, "de_BVG.gtfs.zip"))).toBe(true);
  });

  it("skips hostile catalog names before mirror downloads", async () => {
    const fx = setupCatalog([{ name: "BVG" }, { name: "../../../evil" }]);
    const downloadUrls: string[] = [];
    const downloadTargets: string[] = [];
    const ctx = buildJobContext({
      dataDir: fx.dataDir,
      store: new StateStore(fx.dataDir),
      countries: ["de"],
      source: "mirror",
      runner: async () => {},
      artifactDownloader: async (url, dest) => {
        downloadUrls.push(url);
        downloadTargets.push(dest);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, "BVG");
      },
      now: () => "2026-06-27T00:00:00.000Z",
    });

    const { results } = await runTransitousPipeline(ctx, { stopAt: "fetch-operator" });

    expect(downloadUrls).toContain("https://api.transitous.org/gtfs/de_BVG.gtfs.zip");
    expect(downloadUrls.some((url) => url.includes("evil"))).toBe(false);
    expect(downloadTargets.some((target) => target.includes("evil"))).toBe(false);
    expect(existsSync(join(fx.gtfsDir, "de_BVG.gtfs.zip"))).toBe(true);
    expect(results.find((result) => result.stage === "mirror")?.status).toBe("ok");
  });

  it("unifies mirrored catalog and pinned-fetcher operator artifacts", async () => {
    const fx = setupCatalog([{ name: "BVG" }]);
    const overlayPath = join(fx.dataDir, "feeds-overlay.json");
    writeFileSync(
      overlayPath,
      JSON.stringify({
        version: 3,
        sources: [
          {
            spec: "gtfs",
            type: "http",
            region: "de",
            name: "operator-feed",
            url: "https://operator.example/feed.zip",
            origin: "operator",
            license: {
              spdxIdentifier: "CC-BY-4.0",
              attribution: "Operator authority",
            },
          },
        ],
        patches: [],
        quarantine: [],
      }),
    );
    const fetchMetadata: string[] = [];
    const ctx = buildJobContext({
      dataDir: fx.dataDir,
      store: new StateStore(fx.dataDir),
      countries: ["de"],
      source: "mirror",
      feedsOverlayPath: overlayPath,
      runner: async (command, args) => {
        if (command === "python3" && args[0] === "./src/fetch.py") {
          fetchMetadata.push(args[1] ?? "");
          writeFileSync(join(fx.gtfsDir, "de_operator-feed.gtfs.zip"), "OPERATOR");
        }
      },
      artifactDownloader: async (url, dest) => {
        expect(url).toContain("de_BVG.gtfs.zip");
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, "CATALOG");
      },
      now: () => "2026-06-27T00:00:00.000Z",
    });

    const { results } = await runTransitousPipeline(ctx, { stopAt: "fetch-operator" });
    expect(results.find((result) => result.stage === "fetch-operator")?.status).toBe("ok");
    expect(fetchMetadata).toHaveLength(1);
    expect(fetchMetadata[0]).toMatch(/^\//);
    expect(fetchMetadata[0]).toContain("operator-metadata");
    const metadata = JSON.parse(readFileSync(fetchMetadata[0] as string, "utf-8")) as {
      maintainers: unknown[];
      sources: Array<{ type: string; license: Record<string, unknown> }>;
    };
    expect(metadata.maintainers).toHaveLength(1);
    expect(metadata.sources[0]).toMatchObject({
      type: "http",
      license: {
        "spdx-identifier": "CC-BY-4.0",
        "attribution-text": "Operator authority",
      },
    });
    const manifest = JSON.parse(
      readFileSync(join(fx.gtfsDir, "transit-source-manifest.json"), "utf-8"),
    ) as { sources: Array<{ sourceId: string }> };
    expect(manifest.sources.map((source) => source.sourceId).sort()).toEqual([
      "catalog:de:BVG",
      "operator:de:operator-feed",
    ]);
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

  it("records mirror failures, then blocks at the unified acquisition gate", async () => {
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

    const completed: string[] = [];
    ctx.onStageComplete = async (result) => {
      completed.push(`${result.stage}:${result.status}`);
    };
    await expect(runTransitousPipeline(ctx, { stopAt: "fetch-operator" })).rejects.toThrow(
      /Failed to acquire 1 desired transit source/,
    );
    expect(completed).toContain("mirror:partial");
    expect(completed).toContain("fetch-operator:error");
  });
});

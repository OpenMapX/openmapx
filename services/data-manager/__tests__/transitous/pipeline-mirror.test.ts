import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { transitousRunnerArgv } from "@openmapx/core/transitous-runner";
import type { SafeDownloadOptions } from "@openmapx/core/utils/safe-download";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OperatorFeedRelayStore } from "../../src/jobs/transitous/operator-feed-relay.js";
import {
  buildJobContext,
  runTransitousPipeline,
  stagePolicyFor,
  stagesFor,
} from "../../src/jobs/transitous/pipeline.js";
import { StateStore } from "../../src/state.js";

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
      runScript: async () => {},
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
      runScript: async () => {},
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
    const processArguments: string[][] = [];
    const remoteDownloads: SafeDownloadOptions[] = [];
    const relay = new OperatorFeedRelayStore({
      download: async (options) => {
        remoteDownloads.push(options);
        writeFileSync(options.destination, "OPERATOR");
        return {
          bytesWritten: 8,
          contentType: "application/zip",
          finalUrl: options.url,
        };
      },
    });
    const endRun = vi.spyOn(relay, "endRun");
    const ctx = buildJobContext({
      dataDir: fx.dataDir,
      store: new StateStore(fx.dataDir),
      countries: ["de"],
      source: "mirror",
      jobId: "run-operator-relay",
      feedsOverlayPath: overlayPath,
      runner: async (command, args) => {
        processArguments.push([command, ...args]);
      },
      runScript: async (run) => {
        processArguments.push(["python3", ...transitousRunnerArgv(run)]);
        if (run.script === "fetch-operator") {
          const metadataPath = join(
            fx.dataDir,
            ".transitous-downloads",
            "operator-metadata",
            run.metadataName,
          );
          fetchMetadata.push(metadataPath);
          const metadataText = readFileSync(metadataPath, "utf-8");
          const metadata = JSON.parse(metadataText) as { sources: Array<{ url: string }> };
          const relayUrl = new URL(metadata.sources[0]?.url ?? "");
          const handle = relayUrl.pathname.split("/").at(-1) ?? "";
          const payload = await relay.consume({ handle, runId: "run-operator-relay" });
          const chunks: Buffer[] = [];
          for await (const chunk of payload.stream) chunks.push(Buffer.from(chunk));
          writeFileSync(join(fx.gtfsDir, "de_operator-feed.gtfs.zip"), Buffer.concat(chunks));
          await payload.release();
        }
      },
      operatorFeedRelay: relay,
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
      url: expect.stringMatching(
        /^http:\/\/127\.0\.0\.1:4000\/internal\/transit\/operator-feed\/[a-f0-9]{64}$/,
      ),
      license: {
        "spdx-identifier": "CC-BY-4.0",
        "attribution-text": "Operator authority",
      },
    });
    expect(JSON.stringify(metadata)).not.toContain("operator.example");
    expect(JSON.stringify(processArguments)).not.toContain("operator.example");
    expect(remoteDownloads).toHaveLength(1);
    expect(remoteDownloads[0]).toMatchObject({
      url: new URL("https://operator.example/feed.zip"),
      maxBytes: 512 * 1024 * 1024,
      credentialPolicy: "none",
    });
    expect(endRun).toHaveBeenCalledWith("run-operator-relay");
    const manifest = JSON.parse(
      readFileSync(join(fx.gtfsDir, "transit-source-manifest.json"), "utf-8"),
    ) as { sources: Array<{ sourceId: string }> };
    expect(manifest.sources.map((source) => source.sourceId).sort()).toEqual([
      "catalog:de:BVG",
      "operator:de:operator-feed",
    ]);
    expect(JSON.stringify(manifest)).not.toContain("/internal/transit/operator-feed/");
  });

  it("blocks upstream preparation when relay acquisition fails without exposing a fallback URL", async () => {
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
            url: "https://operator.example/private/feed.zip?fixture=secret",
            origin: "operator",
            license: { spdxIdentifier: "CC-BY-4.0", attribution: "Operator" },
          },
        ],
        patches: [],
        quarantine: [],
      }),
    );
    const relay = new OperatorFeedRelayStore({
      download: async () => {
        throw new Error("redirect target is private");
      },
    });
    const completed: string[] = [];
    const persistedResults: unknown[] = [];
    const ctx = buildJobContext({
      dataDir: fx.dataDir,
      store: new StateStore(fx.dataDir),
      countries: ["de"],
      source: "mirror",
      jobId: "run-relay-failure",
      feedsOverlayPath: overlayPath,
      operatorFeedRelay: relay,
      runner: async () => {},
      runScript: async (run) => {
        if (run.script !== "fetch-operator") return;
        const metadataPath = join(
          fx.dataDir,
          ".transitous-downloads",
          "operator-metadata",
          run.metadataName,
        );
        const metadata = JSON.parse(readFileSync(metadataPath, "utf-8")) as {
          sources: Array<{ url: string }>;
        };
        const relayUrl = new URL(metadata.sources[0]?.url ?? "");
        const handle = relayUrl.pathname.split("/").at(-1) ?? "";
        try {
          await relay.consume({ handle, runId: "run-relay-failure" });
        } catch {
          throw new Error(`fetch failed for ${relayUrl.toString()}`);
        }
      },
      artifactDownloader: async (_url, destination) => {
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(destination, "CATALOG");
      },
      onStageComplete: async (result) => {
        completed.push(`${result.stage}:${result.status}`);
        persistedResults.push(result);
      },
    });

    await expect(runTransitousPipeline(ctx, { stopAt: "fetch-operator" })).rejects.toThrow(
      /Failed to acquire 1 desired transit source/,
    );
    expect(completed).toContain("fetch-operator:error");
    expect(completed.some((entry) => entry.startsWith("validate:"))).toBe(false);
    expect(existsSync(join(fx.gtfsDir, "de_operator-feed.gtfs.zip"))).toBe(false);
    const failedResult = completed.join("\n");
    expect(failedResult).not.toContain("operator.example");
    expect(failedResult).not.toContain("fixture=secret");
    const persistedJson = JSON.stringify(persistedResults);
    expect(persistedJson).not.toContain("operator.example");
    expect(persistedJson).not.toContain("fixture=secret");
    expect(persistedJson).not.toMatch(/operator-feed\/[a-f0-9]{64}/);
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
      runScript: async () => {},
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
      runScript: async () => {},
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

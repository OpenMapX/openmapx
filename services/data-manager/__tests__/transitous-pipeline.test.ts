import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildJobContext, runTransitousPipeline } from "../src/jobs/transitous/index.js";
import { StateStore } from "../src/state.js";
import { writeFixtureGtfsArchive } from "./helpers/gtfs-fixture.js";

let tmp: string | undefined;

afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  }
});

/**
 * These integration tests pin the behavior of the staged Transitous pipeline
 * end-to-end, including selection counts, acquired artifacts, and structured
 * per-source failures retained in the pipeline job state.
 */
describe("runTransitousPipeline (integration)", () => {
  it("runs the Transitous fetch pipeline, applies API keys, and prunes stale country data", async () => {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-transitous-pipeline-"));
    const dataDir = tmp;
    const catalogDir = join(dataDir, ".transitous-catalog");
    const gtfsDir = join(dataDir, "gtfs");
    const downloadsDir = join(dataDir, ".transitous-downloads");
    mkdirSync(join(catalogDir, ".git"), { recursive: true });
    mkdirSync(join(catalogDir, "feeds"), { recursive: true });
    mkdirSync(join(catalogDir, "src"), { recursive: true });
    mkdirSync(gtfsDir, { recursive: true });
    mkdirSync(downloadsDir, { recursive: true });

    const deFeedPath = join(catalogDir, "feeds", "de.json");
    const originalDeFeed = JSON.stringify(
      {
        sources: [
          {
            name: "BVG",
            skip: true,
            "transitland-atlas-id": "f-de-bvg",
          },
          {
            name: "VBB",
          },
        ],
      },
      null,
      2,
    );
    writeFileSync(deFeedPath, originalDeFeed);
    writeFileSync(
      join(catalogDir, "feeds", "us.json"),
      JSON.stringify({ sources: [{ name: "MBTA" }] }, null, 2),
    );
    writeFileSync(join(catalogDir, "src", "garbage-collect.py"), "#!/usr/bin/env python3\n");
    writeFixtureGtfsArchive(join(gtfsDir, "us_old.gtfs.zip"));

    const apiKeysPath = join(tmp, "api-keys.json");
    writeFileSync(apiKeysPath, JSON.stringify({ "de/BVG": "secret-key" }, null, 2));

    const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
    let fetchSawApiKey = false;
    const runner = async (
      command: string,
      args: string[],
      opts: { cwd?: string; stdio?: "inherit" | "pipe" },
    ) => {
      calls.push({ command, args, cwd: opts.cwd });
      if (command === "git" && args.includes("reset") && args.includes("--hard")) {
        writeFileSync(deFeedPath, originalDeFeed);
        return;
      }
      if (command === "python3" && args[0] === "./src/fetch.py" && args[1] === "feeds/de.json") {
        const feed = JSON.parse(readFileSync(deFeedPath, "utf-8")) as {
          sources: Array<Record<string, unknown>>;
        };
        fetchSawApiKey = feed.sources[0]?.["api-key"] === "secret-key";
        writeFixtureGtfsArchive(join(gtfsDir, "de_bvg.gtfs.zip"));
        writeFixtureGtfsArchive(join(gtfsDir, "de_vbb.gtfs.zip"));
        return;
      }
    };

    const ctx = buildJobContext({
      countries: ["de"],
      dataDir,
      store: new StateStore(dataDir),
      apiKeysPath,
      runner,
      now: () => "2026-04-20T12:00:00.000Z",
    });
    await runTransitousPipeline(ctx);
    expect(ctx.state.requestedCount).toBe(3);
    expect(ctx.state.selectedCount).toBe(2);
    expect(ctx.state.skippedCount).toBe(1);
    expect(ctx.state.fetchFailures ?? []).toEqual([]);
    expect(ctx.state.downloaded?.map((dataset) => dataset.id)).toEqual(["de_bvg", "de_vbb"]);

    expect(fetchSawApiKey).toBe(true);

    const updatedFeed = JSON.parse(readFileSync(deFeedPath, "utf-8")) as {
      sources: Array<Record<string, unknown>>;
    };
    expect(updatedFeed.sources[0]?.["api-key"]).toBeUndefined();
    expect(updatedFeed.sources[0]?.skip).toBe(true);

    expect(existsSync(join(gtfsDir, "us_old.gtfs.zip"))).toBe(false);
    expect(existsSync(join(gtfsDir, "de_bvg.gtfs.zip"))).toBe(true);
    expect(existsSync(join(gtfsDir, "de_vbb.gtfs.zip"))).toBe(true);

    const state = JSON.parse(readFileSync(join(dataDir, ".data-manager-state.json"), "utf-8")) as {
      datasets: Array<{ id: string }>;
    };
    expect(state.datasets.map((dataset) => dataset.id)).toEqual(["de_bvg", "de_vbb"]);

    const safeDir = `-c safe.directory=${catalogDir}`;
    const callSignatures = calls.map((call) => `${call.command} ${call.args.join(" ")}`);
    expect(callSignatures).toContain(`git ${safeDir} -C ${catalogDir} reset --hard HEAD`);
    expect(callSignatures).toContain(`git ${safeDir} -C ${catalogDir} pull --ff-only`);
    expect(callSignatures).toContain(
      `git ${safeDir} -C ${catalogDir} submodule update --init --checkout --depth 1`,
    );
    expect(callSignatures).toContain("python3 ./src/fetch.py feeds/de.json");
    expect(callSignatures).toContain("python3 ./src/garbage-collect.py --non-interactive");
  });

  it("creates the data directory before cloning the Transitous catalog", async () => {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-transitous-bootstrap-"));
    const dataDir = join(tmp, "fresh-data");
    const catalogDir = join(dataDir, ".transitous-catalog");

    const runner = async (
      command: string,
      args: string[],
      _opts: { cwd?: string; stdio?: "inherit" | "pipe" },
    ) => {
      if (command === "git" && args.includes("clone")) {
        expect(existsSync(dataDir)).toBe(true);
        mkdirSync(join(catalogDir, ".git"), { recursive: true });
        mkdirSync(join(catalogDir, "feeds"), { recursive: true });
        mkdirSync(join(catalogDir, "src"), { recursive: true });
        writeFileSync(
          join(catalogDir, "feeds", "de.json"),
          JSON.stringify({ sources: [{ name: "Demo" }] }, null, 2),
        );
        return;
      }

      if (command === "python3" && args[0] === "./src/fetch.py") {
        writeFixtureGtfsArchive(join(dataDir, "gtfs", "de_demo.gtfs.zip"));
      }
    };

    const ctx = buildJobContext({
      countries: ["de"],
      dataDir,
      store: new StateStore(dataDir),
      transitousRepoUrl: "/tmp/fake-transitous.git",
      runner,
      now: () => "2026-04-20T12:00:00.000Z",
    });
    await runTransitousPipeline(ctx);
    expect(ctx.state.downloaded?.map((dataset) => dataset.id)).toEqual(["de_demo"]);
    expect(existsSync(join(dataDir, "gtfs", "de_demo.gtfs.zip"))).toBe(true);
  });

  it("counts and imports NeTEx schedule sources from the Transitous catalog", async () => {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-transitous-netex-"));
    const dataDir = tmp;
    const catalogDir = join(dataDir, ".transitous-catalog");
    mkdirSync(join(catalogDir, ".git"), { recursive: true });
    mkdirSync(join(catalogDir, "feeds"), { recursive: true });
    writeFileSync(
      join(catalogDir, "feeds", "no.json"),
      JSON.stringify(
        {
          sources: [{ name: "Entur", spec: "netex" }],
        },
        null,
        2,
      ),
    );

    const ctx = buildJobContext({
      countries: ["no"],
      dataDir,
      store: new StateStore(dataDir),
      runner: async (command, args) => {
        if (command === "python3" && args[0] === "./src/fetch.py" && args[1] === "feeds/no.json") {
          writeFixtureGtfsArchive(join(dataDir, "gtfs", "no_entur.netex.zip"));
        }
      },
      now: () => "2026-04-20T12:00:00.000Z",
    });
    await runTransitousPipeline(ctx);
    expect(ctx.state.requestedCount).toBe(1);
    expect(ctx.state.selectedCount).toBe(1);
    expect(ctx.state.skippedCount).toBe(0);
    expect(ctx.state.fetchFailures ?? []).toEqual([]);
    expect(ctx.state.downloaded?.map((dataset) => dataset.id)).toEqual(["no_entur"]);
    expect(existsSync(join(dataDir, "gtfs", "no_entur.netex.zip"))).toBe(true);
  });

  it("preserves existing GTFS data when the country filter matches no Transitous feed files", async () => {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-transitous-no-match-"));
    const dataDir = tmp;
    const catalogDir = join(dataDir, ".transitous-catalog");
    const gtfsDir = join(dataDir, "gtfs");
    mkdirSync(join(catalogDir, ".git"), { recursive: true });
    mkdirSync(join(catalogDir, "feeds"), { recursive: true });
    writeFileSync(
      join(catalogDir, "feeds", "de.json"),
      JSON.stringify({ sources: [{ name: "BVG" }] }, null, 2),
    );
    mkdirSync(gtfsDir, { recursive: true });
    const existingArchive = join(gtfsDir, "de_bvg.gtfs.zip");
    writeFileSync(existingArchive, "BVG");

    const store = new StateStore(dataDir);
    store.upsert({
      type: "gtfs",
      id: "de_bvg",
      sizeBytes: 3,
      downloadedAt: "2026-04-19T12:00:00.000Z",
      path: existingArchive,
    });

    const ctx = buildJobContext({
      countries: ["zz"],
      dataDir,
      store,
      runner: async () => {},
      now: () => "2026-04-20T12:00:00.000Z",
    });
    await expect(runTransitousPipeline(ctx)).rejects.toThrow(
      /does not contain any feed files for countries: zz/,
    );

    expect(existsSync(existingArchive)).toBe(true);
    const state = JSON.parse(readFileSync(join(dataDir, ".data-manager-state.json"), "utf-8")) as {
      datasets: Array<{ id: string }>;
    };
    expect(state.datasets.map((dataset) => dataset.id)).toEqual(["de_bvg"]);
  });

  it("records malformed feed evidence but blocks promotion of the reduced source set", async () => {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-transitous-parse-failure-"));
    const dataDir = tmp;
    const catalogDir = join(dataDir, ".transitous-catalog");
    mkdirSync(join(catalogDir, ".git"), { recursive: true });
    mkdirSync(join(catalogDir, "feeds"), { recursive: true });
    writeFileSync(join(catalogDir, "feeds", "de.json"), "{not valid json\n");
    writeFileSync(
      join(catalogDir, "feeds", "us.json"),
      JSON.stringify({ sources: [{ name: "MBTA" }] }, null, 2),
    );

    const ctx = buildJobContext({
      countries: ["de", "us"],
      dataDir,
      store: new StateStore(dataDir),
      runner: async (command, args) => {
        if (command === "python3" && args[0] === "./src/fetch.py" && args[1] === "feeds/us.json") {
          writeFixtureGtfsArchive(join(dataDir, "gtfs", "us_mbta.gtfs.zip"));
        }
      },
      now: () => "2026-04-20T12:00:00.000Z",
    });
    await expect(runTransitousPipeline(ctx)).rejects.toThrow(/Fetched 1\/2 feed source/);
    expect(ctx.state.requestedCount).toBe(2);
    expect(ctx.state.selectedCount).toBe(2);
    expect(ctx.state.skippedCount).toBe(0);
    expect(ctx.state.downloaded ?? []).toEqual([]);
    expect(existsSync(join(dataDir, "gtfs", "us_mbta.gtfs.zip"))).toBe(true);
    expect(ctx.state.fetchFailures).toEqual([
      {
        id: "de",
        country: "de",
        url: "https://raw.githubusercontent.com/public-transport/transitous/main/feeds/de.json",
        message: expect.stringContaining("Failed to parse Transitous feed file de.json"),
      },
    ]);
  });

  it("preserves existing archives across a failed refresh and does not stamp them as freshly downloaded", async () => {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-transitous-stale-archive-"));
    const dataDir = tmp;
    const catalogDir = join(dataDir, ".transitous-catalog");
    const gtfsDir = join(dataDir, "gtfs");
    mkdirSync(join(catalogDir, ".git"), { recursive: true });
    mkdirSync(join(catalogDir, "feeds"), { recursive: true });
    writeFileSync(
      join(catalogDir, "feeds", "de.json"),
      JSON.stringify({ sources: [{ name: "BVG" }] }, null, 2),
    );
    mkdirSync(gtfsDir, { recursive: true });
    const staleArchive = join(gtfsDir, "de_bvg.gtfs.zip");
    writeFileSync(staleArchive, "STALE");

    const store = new StateStore(dataDir);
    store.upsert({
      type: "gtfs",
      id: "de_bvg",
      sizeBytes: 5,
      downloadedAt: "2026-04-19T12:00:00.000Z",
      path: staleArchive,
    });

    const runner = async (
      command: string,
      args: string[],
      _opts: { cwd?: string; stdio?: "inherit" | "pipe" },
    ) => {
      if (command === "python3" && args[0] === "./src/fetch.py") {
        throw new Error("HTTP 503");
      }
      if (command === "git" && args.includes("reset") && args.includes("--hard")) {
        return;
      }
    };

    const ctx = buildJobContext({
      countries: ["de"],
      dataDir,
      store,
      runner,
      now: () => "2026-04-20T12:00:00.000Z",
    });
    await expect(runTransitousPipeline(ctx)).rejects.toThrow(/Fetched 0\/1 feed source/);
    expect(ctx.state.downloaded ?? []).toEqual([]);
    expect(ctx.state.fetchFailures).toEqual([
      {
        id: "de_bvg",
        country: "de",
        url: "https://raw.githubusercontent.com/public-transport/transitous/main/feeds/de.json",
        message: "HTTP 503",
      },
    ]);

    // Crash-resume: the previously downloaded archive stays on disk so the
    // next run picks up where this one left off.
    expect(existsSync(staleArchive)).toBe(true);
    expect(readFileSync(staleArchive, "utf-8")).toBe("STALE");

    const state = JSON.parse(readFileSync(join(dataDir, ".data-manager-state.json"), "utf-8")) as {
      datasets: Array<{ id: string; downloadedAt: string }>;
    };
    expect(state.datasets).toHaveLength(1);
    expect(state.datasets[0]).toMatchObject({
      id: "de_bvg",
      downloadedAt: "2026-04-19T12:00:00.000Z",
    });
  });

  it("excludes Transitland GBFS-only sources from GTFS schedule counts", async () => {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-transitous-atlas-spec-"));
    const dataDir = tmp;
    const catalogDir = join(dataDir, ".transitous-catalog");
    mkdirSync(join(catalogDir, ".git"), { recursive: true });
    mkdirSync(join(catalogDir, "feeds"), { recursive: true });
    mkdirSync(join(catalogDir, "transitland-atlas", "feeds"), { recursive: true });

    writeFileSync(
      join(catalogDir, "feeds", "de.json"),
      JSON.stringify(
        {
          sources: [
            {
              name: "TransitGBFS",
              type: "transitland-atlas",
              "transitland-atlas-id": "f-de-gbfs",
            },
            {
              name: "TransitGTFS",
              type: "transitland-atlas",
              "transitland-atlas-id": "f-de-gtfs",
            },
            {
              name: "HttpGTFS",
              type: "http",
              url: "https://example.test/http-gtfs.zip",
            },
          ],
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(catalogDir, "transitland-atlas", "feeds", "de.dmfr.json"),
      JSON.stringify(
        {
          feeds: [
            { id: "f-de-gbfs", urls: { gbfs_auto_discovery: "https://example.test/gbfs.json" } },
            { id: "f-de-gtfs", urls: { static_current: "https://example.test/gtfs.zip" } },
          ],
        },
        null,
        2,
      ),
    );

    const ctx = buildJobContext({
      countries: ["de"],
      dataDir,
      store: new StateStore(dataDir),
      runner: async (command, args) => {
        if (command === "python3" && args[0] === "./src/fetch.py" && args[1] === "feeds/de.json") {
          writeFixtureGtfsArchive(join(dataDir, "gtfs", "de_transitgtfs.gtfs.zip"));
          writeFixtureGtfsArchive(join(dataDir, "gtfs", "de_httpgtfs.gtfs.zip"));
        }
      },
      now: () => "2026-04-20T12:00:00.000Z",
    });
    await runTransitousPipeline(ctx);
    expect(ctx.state.requestedCount).toBe(2);
    expect(ctx.state.selectedCount).toBe(2);
    expect(ctx.state.skippedCount).toBe(0);
    expect(ctx.state.fetchFailures ?? []).toEqual([]);
    expect(ctx.state.downloaded?.map((dataset) => dataset.id)).toEqual([
      "de_httpgtfs",
      "de_transitgtfs",
    ]);
  });

  it("attributes fetch failures to the source names reported by Transitous fetch.py", async () => {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-transitous-failure-attribution-"));
    const dataDir = tmp;
    const catalogDir = join(dataDir, ".transitous-catalog");
    mkdirSync(join(catalogDir, ".git"), { recursive: true });
    mkdirSync(join(catalogDir, "feeds"), { recursive: true });

    writeFileSync(
      join(catalogDir, "feeds", "de.json"),
      JSON.stringify(
        {
          sources: [{ name: "A" }, { name: "B" }, { name: "C" }],
        },
        null,
        2,
      ),
    );

    const ctx = buildJobContext({
      countries: ["de"],
      dataDir,
      store: new StateStore(dataDir),
      runner: async (command, args) => {
        if (command === "python3" && args[0] === "./src/fetch.py") {
          throw new Error(
            [
              "Error: Could not fetch de-A: HTTP 500",
              "Error: Could not postprocess de-B: Feed is expired",
              "Error: 2 errors occurred during fetching.",
            ].join("\n"),
          );
        }
      },
      now: () => "2026-04-20T12:00:00.000Z",
    });
    await expect(runTransitousPipeline(ctx)).rejects.toThrow(/Fetched 1\/3 feed source/);
    expect(ctx.state.selectedCount).toBe(3);
    expect(ctx.state.downloaded ?? []).toEqual([]);
    expect(ctx.state.fetchFailures).toEqual([
      {
        id: "de_a",
        country: "de",
        url: "https://raw.githubusercontent.com/public-transport/transitous/main/feeds/de.json",
        message: expect.stringContaining("Could not fetch de-A"),
      },
      {
        id: "de_b",
        country: "de",
        url: "https://raw.githubusercontent.com/public-transport/transitous/main/feeds/de.json",
        message: expect.stringContaining("Could not postprocess de-B"),
      },
    ]);
  });
});

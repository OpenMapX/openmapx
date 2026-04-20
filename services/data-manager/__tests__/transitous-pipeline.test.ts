import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { downloadGtfsViaTransitous } from "../src/jobs/transitous-pipeline.js";
import { StateStore } from "../src/state.js";

let tmp: string | undefined;

afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  }
});

describe("downloadGtfsViaTransitous", () => {
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
    writeFileSync(join(gtfsDir, "us_old.gtfs.zip"), "STALE");

    const apiKeysPath = join(tmp, "api-keys.json");
    writeFileSync(apiKeysPath, JSON.stringify({ "de/BVG": "secret-key" }, null, 2));

    const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
    let fetchSawApiKey = false;
    const runner = async (
      command: string,
      args: string[],
      _opts: { cwd?: string; stdio?: "inherit" | "pipe" },
    ) => {
      calls.push({ command, args, cwd: opts.cwd });
      if (command === "git" && args.join(" ") === `-C ${catalogDir} reset --hard HEAD`) {
        writeFileSync(deFeedPath, originalDeFeed);
        return;
      }
      if (command === "python3" && args[0] === "./src/fetch.py" && args[1] === "feeds/de.json") {
        const feed = JSON.parse(readFileSync(deFeedPath, "utf-8")) as {
          sources: Array<Record<string, unknown>>;
        };
        fetchSawApiKey = feed.sources[0]?.["api-key"] === "secret-key";
        writeFileSync(join(gtfsDir, "de_bvg.gtfs.zip"), "BVG");
        writeFileSync(join(gtfsDir, "de_vbb.gtfs.zip"), "VBB");
        return;
      }
    };

    const result = await downloadGtfsViaTransitous({
      countries: ["de"],
      dataDir,
      store: new StateStore(dataDir),
      apiKeysPath,
      runner,
      now: () => "2026-04-20T12:00:00.000Z",
    });

    expect(result.requestedCount).toBe(3);
    expect(result.selectedCount).toBe(2);
    expect(result.skippedCount).toBe(1);
    expect(result.failures).toEqual([]);
    expect(result.downloaded.map((dataset) => dataset.id)).toEqual(["de_bvg", "de_vbb"]);

    expect(fetchSawApiKey).toBe(true);

    const updatedFeed = JSON.parse(readFileSync(deFeedPath, "utf-8")) as {
      sources: Array<Record<string, unknown>>;
    };
    expect(updatedFeed.sources[0]?.["api-key"]).toBeUndefined();
    expect(updatedFeed.sources[0]?.skip).toBe(true);

    expect(() => readFileSync(join(gtfsDir, "us_old.gtfs.zip"), "utf-8")).toThrow();
    expect(readFileSync(join(gtfsDir, "de_bvg.gtfs.zip"), "utf-8")).toBe("BVG");
    expect(readFileSync(join(gtfsDir, "de_vbb.gtfs.zip"), "utf-8")).toBe("VBB");

    const state = JSON.parse(readFileSync(join(dataDir, ".data-manager-state.json"), "utf-8")) as {
      datasets: Array<{ id: string }>;
    };
    expect(state.datasets.map((dataset) => dataset.id)).toEqual(["de_bvg", "de_vbb"]);

    const callSignatures = calls.map((call) => `${call.command} ${call.args.join(" ")}`);
    expect(callSignatures).toContain(`git -C ${catalogDir} reset --hard HEAD`);
    expect(callSignatures).toContain(`git -C ${catalogDir} pull --ff-only`);
    expect(callSignatures).toContain(
      `git -C ${catalogDir} submodule update --init --checkout --depth 1`,
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
      if (command === "git" && args[0] === "clone") {
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
        writeFileSync(join(dataDir, "gtfs", "de_demo.gtfs.zip"), "DEMO");
      }
    };

    const result = await downloadGtfsViaTransitous({
      countries: ["de"],
      dataDir,
      store: new StateStore(dataDir),
      transitousRepoUrl: "/tmp/fake-transitous.git",
      runner,
      now: () => "2026-04-20T12:00:00.000Z",
    });

    expect(result.downloaded.map((dataset) => dataset.id)).toEqual(["de_demo"]);
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

    const result = await downloadGtfsViaTransitous({
      countries: ["no"],
      dataDir,
      store: new StateStore(dataDir),
      runner: async (command, args) => {
        if (command === "python3" && args[0] === "./src/fetch.py" && args[1] === "feeds/no.json") {
          writeFileSync(join(dataDir, "gtfs", "no_entur.netex.zip"), "NETEX");
        }
      },
      now: () => "2026-04-20T12:00:00.000Z",
    });

    expect(result.requestedCount).toBe(1);
    expect(result.selectedCount).toBe(1);
    expect(result.skippedCount).toBe(0);
    expect(result.failures).toEqual([]);
    expect(result.downloaded.map((dataset) => dataset.id)).toEqual(["no_entur"]);
    expect(readFileSync(join(dataDir, "gtfs", "no_entur.netex.zip"), "utf-8")).toBe("NETEX");
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

    await expect(
      downloadGtfsViaTransitous({
        countries: ["zz"],
        dataDir,
        store,
        runner: async () => {},
        now: () => "2026-04-20T12:00:00.000Z",
      }),
    ).rejects.toThrow(/does not contain any feed files for countries: zz/);

    expect(existsSync(existingArchive)).toBe(true);
    const state = JSON.parse(readFileSync(join(dataDir, ".data-manager-state.json"), "utf-8")) as {
      datasets: Array<{ id: string }>;
    };
    expect(state.datasets.map((dataset) => dataset.id)).toEqual(["de_bvg"]);
  });

  it("reports malformed Transitous feed files as isolated failures without aborting other feeds", async () => {
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

    const result = await downloadGtfsViaTransitous({
      countries: [],
      dataDir,
      store: new StateStore(dataDir),
      runner: async (command, args) => {
        if (command === "python3" && args[0] === "./src/fetch.py" && args[1] === "feeds/us.json") {
          writeFileSync(join(dataDir, "gtfs", "us_mbta.gtfs.zip"), "MBTA");
        }
      },
      now: () => "2026-04-20T12:00:00.000Z",
    });

    expect(result.requestedCount).toBe(2);
    expect(result.selectedCount).toBe(2);
    expect(result.skippedCount).toBe(0);
    expect(result.downloaded.map((dataset) => dataset.id)).toEqual(["us_mbta"]);
    expect(result.failures).toEqual([
      {
        id: "de",
        country: "de",
        url: "https://raw.githubusercontent.com/public-transport/transitous/main/feeds/de.json",
        message: expect.stringContaining("Failed to parse Transitous feed file de.json"),
      },
    ]);
  });

  it("does not count unchanged stale archives as freshly downloaded after a failed refresh", async () => {
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
      if (command === "git" && args.join(" ") === `-C ${catalogDir} reset --hard HEAD`) {
        return;
      }
    };

    const result = await downloadGtfsViaTransitous({
      countries: ["de"],
      dataDir,
      store,
      runner,
      now: () => "2026-04-20T12:00:00.000Z",
    });

    expect(result.downloaded).toEqual([]);
    expect(result.failures).toEqual([
      {
        id: "de_bvg",
        country: "de",
        url: "https://raw.githubusercontent.com/public-transport/transitous/main/feeds/de.json",
        message: "HTTP 503",
      },
    ]);
    expect(existsSync(staleArchive)).toBe(false);

    const state = JSON.parse(readFileSync(join(dataDir, ".data-manager-state.json"), "utf-8")) as {
      datasets: Array<{ id: string; downloadedAt: string }>;
    };
    expect(state.datasets).toEqual([]);
  });
});

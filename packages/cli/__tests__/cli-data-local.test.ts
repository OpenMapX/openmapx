import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyDataCleanup,
  collectOfflineDataStatus,
  planDataCleanup,
  pruneDataManagerStateForCleanup,
  summarizePath,
} from "../src/lib/data-local";

let tmp: string;

function writeManifest(slug: string, body: Record<string, unknown>) {
  const dir = join(tmp, "services", slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "service.json"), JSON.stringify(body), "utf-8");
}

const baseManifest = {
  name: "Test",
  version: "1.0.0",
  quality: "built-in",
  container: { image: "t/x", tag: "latest", expose: [80] },
};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "openmapx-cli-data-local-"));
  writeFileSync(join(tmp, "pnpm-workspace.yaml"), "packages: []\n");
  mkdirSync(join(tmp, "services"), { recursive: true });
  mkdirSync(join(tmp, "infra", "docker", "data"), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("collectOfflineDataStatus", () => {
  it("summarizes OSM + GTFS files and top-level directory usage", () => {
    const dataRoot = join(tmp, "infra", "docker", "data");
    mkdirSync(join(dataRoot, "osm"), { recursive: true });
    mkdirSync(join(dataRoot, "gtfs"), { recursive: true });
    mkdirSync(join(dataRoot, "valhalla", "osm-pbf"), { recursive: true });

    writeFileSync(join(dataRoot, "osm", "planet.osm.pbf"), "PBF");
    writeFileSync(join(dataRoot, "gtfs", "feed-a.zip"), "A");
    writeFileSync(join(dataRoot, "gtfs", "feed-b.zip"), "BB");
    writeFileSync(join(dataRoot, "valhalla", "osm-pbf", "planet.osm.pbf"), "PBF");

    const status = collectOfflineDataStatus(tmp);

    expect(status.osmPbfFiles.map((file) => file.name)).toEqual(["planet.osm.pbf"]);
    expect(status.gtfsZipFiles.map((file) => file.name)).toEqual(["feed-a.zip", "feed-b.zip"]);
    expect(status.directories.map((dir) => dir.name)).toEqual(["gtfs", "osm", "valhalla"]);
    expect(status.totalFiles).toBe(4);
  });
});

describe("planDataCleanup", () => {
  it("maps a concrete data type to producer + consumer paths", async () => {
    writeManifest("data-manager", {
      ...baseManifest,
      id: "data-manager",
      provides: ["osm-data"],
      produces: [{ type: "osm-pbf", sourceDir: "data/osm" }],
    });
    writeManifest("valhalla", {
      ...baseManifest,
      id: "valhalla",
      consumes: [{ type: "osm-pbf", mountAt: "/custom_files", required: true }],
    });

    const plan = await planDataCleanup("osm-pbf", tmp);

    expect(plan.all).toBe(false);
    expect(plan.normalizedTypes).toEqual(["osm-pbf"]);
    expect(plan.paths).toEqual([
      join(tmp, "infra", "docker", "data", "osm"),
      join(tmp, "infra", "docker", "data", "valhalla", "osm-pbf"),
    ]);
  });

  it("expands style alias into tile-fonts + tile-styles", async () => {
    writeManifest("data-manager", {
      ...baseManifest,
      id: "data-manager",
      provides: ["tile-asset-data"],
      produces: [
        { type: "tile-fonts", sourceDir: "data/tile-fonts" },
        { type: "tile-styles", sourceDir: "data/tile-styles" },
      ],
    });
    writeManifest("tileserver", {
      ...baseManifest,
      id: "tileserver",
      consumes: [
        { type: "tile-fonts", mountAt: "/data/fonts", required: true },
        { type: "tile-styles", mountAt: "/data/styles", required: true },
      ],
    });

    const plan = await planDataCleanup("style", tmp);

    expect(plan.normalizedTypes.sort()).toEqual(["tile-fonts", "tile-styles"]);
    expect(plan.paths).toEqual([
      join(tmp, "infra", "docker", "data", "tile-fonts"),
      join(tmp, "infra", "docker", "data", "tile-styles"),
      join(tmp, "infra", "docker", "data", "tileserver", "tile-fonts"),
      join(tmp, "infra", "docker", "data", "tileserver", "tile-styles"),
    ]);
  });

  it("supports all cleanup as the data-root path", async () => {
    writeManifest("data-manager", {
      ...baseManifest,
      id: "data-manager",
      provides: ["osm-data"],
      produces: [{ type: "osm-pbf", sourceDir: "data/osm" }],
    });

    const plan = await planDataCleanup("all", tmp);

    expect(plan.all).toBe(true);
    expect(plan.paths).toEqual([join(tmp, "infra", "docker", "data")]);
  });

  it("includes instance-scoped consumer target paths", async () => {
    writeManifest("data-manager", {
      ...baseManifest,
      id: "data-manager",
      produces: [{ type: "otp-graph", sourceDir: "data/otp-graph" }],
    });
    writeManifest("otp", {
      ...baseManifest,
      id: "otp",
      consumes: [
        { type: "otp-graph", instance: "de", mountAt: "/var/opentripplanner", required: true },
      ],
    });

    const plan = await planDataCleanup("otp-graph", tmp);

    expect(plan.paths).toEqual([
      join(tmp, "infra", "docker", "data", "otp-graph"),
      join(tmp, "infra", "docker", "data", "otp", "otp-graph", "de"),
    ]);
  });

  it("throws on unknown cleanup target", async () => {
    writeManifest("data-manager", {
      ...baseManifest,
      id: "data-manager",
      provides: ["osm-data"],
      produces: [{ type: "osm-pbf", sourceDir: "data/osm" }],
    });

    await expect(planDataCleanup("unknown-type", tmp)).rejects.toThrow(/Unknown clean target/);
  });
});

describe("applyDataCleanup", () => {
  it("removes existing paths and reports removed files/bytes", () => {
    const dataRoot = join(tmp, "infra", "docker", "data");
    const source = join(dataRoot, "osm");
    const target = join(dataRoot, "valhalla", "osm-pbf");

    mkdirSync(source, { recursive: true });
    mkdirSync(target, { recursive: true });
    writeFileSync(join(source, "planet.osm.pbf"), "PBF");
    writeFileSync(join(target, "planet.osm.pbf"), "PBF");

    const before = summarizePath(dataRoot);
    const result = applyDataCleanup([source, target]);

    expect(result.removedPaths).toBe(2);
    expect(result.removedFiles).toBe(2);
    expect(result.removedBytes).toBeGreaterThan(0);
    expect(summarizePath(dataRoot).files).toBe(before.files - 2);
  });
});

describe("pruneDataManagerStateForCleanup", () => {
  it("drops matching datasets from .data-manager-state.json", async () => {
    writeManifest("data-manager", {
      ...baseManifest,
      id: "data-manager",
      produces: [{ type: "osm-pbf", sourceDir: "data/osm" }],
    });
    writeManifest("valhalla", {
      ...baseManifest,
      id: "valhalla",
      consumes: [{ type: "osm-pbf", mountAt: "/custom_files", required: true }],
    });

    const dataRoot = join(tmp, "infra", "docker", "data");
    writeFileSync(
      join(dataRoot, ".data-manager-state.json"),
      JSON.stringify(
        {
          datasets: [
            {
              type: "osm-pbf",
              id: "europe-germany",
              path: "/data/osm/europe-germany.osm.pbf",
              sizeBytes: 123,
              downloadedAt: "2026-01-01T00:00:00.000Z",
            },
            {
              type: "gtfs",
              id: "de_db",
              path: "/data/gtfs/de_db.zip",
              sizeBytes: 10,
              downloadedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const plan = await planDataCleanup("osm-pbf", tmp);
    const result = pruneDataManagerStateForCleanup(plan);
    expect(result.updated).toBe(true);
    expect(result.removedDatasets).toBe(1);

    const state = JSON.parse(readFileSync(join(dataRoot, ".data-manager-state.json"), "utf-8")) as {
      datasets: Array<{ type: string; id: string }>;
    };
    expect(state.datasets.map((dataset) => ({ type: dataset.type, id: dataset.id }))).toEqual([
      { type: "gtfs", id: "de_db" },
    ]);
  });
});

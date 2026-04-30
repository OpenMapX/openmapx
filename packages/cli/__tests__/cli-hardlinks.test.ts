import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyGeneratedHardlinks, applyHardlinkPlan } from "../src/lib/hardlinks";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "openmapx-cli-hardlinks-"));
  writeFileSync(join(tmp, "pnpm-workspace.yaml"), "packages: []\n");
  mkdirSync(join(tmp, "services"), { recursive: true });
  mkdirSync(join(tmp, "infra", "docker", "data"), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("cli hardlink helpers", () => {
  it("links source files into target and leaves unknown pre-existing target files alone", () => {
    const src = join(tmp, "infra", "docker", "data", "osm");
    const tgt = join(tmp, "infra", "docker", "data", "valhalla", "osm-pbf");
    mkdirSync(src, { recursive: true });
    mkdirSync(tgt, { recursive: true });
    writeFileSync(join(src, "region.osm.pbf"), "fresh");
    // A pre-existing file in the target we never linked (could be a
    // container-written artifact like valhalla_tiles.tar). The new prune
    // model must not delete it — only files we previously linked and that
    // have since disappeared from source are removed.
    writeFileSync(join(tgt, "valhalla_tiles.tar"), "tiles");

    const result = applyHardlinkPlan(
      [
        {
          source: "data/osm",
          target: "data/valhalla/osm-pbf",
          consumerService: "valhalla",
          dataType: "osm-pbf",
        },
      ],
      { rootDir: join(tmp, "infra", "docker", "data") },
    );

    expect(result).toEqual({ linked: 1, skipped: 0, pruned: 0 });
    expect(readFileSync(join(tgt, "region.osm.pbf"), "utf-8")).toBe("fresh");
    expect(statSync(join(src, "region.osm.pbf")).ino).toBe(
      statSync(join(tgt, "region.osm.pbf")).ino,
    );
    expect(existsSync(join(tgt, "valhalla_tiles.tar"))).toBe(true);
  });

  it("prunes only files we previously linked when the producer removes them", () => {
    const dataRoot = join(tmp, "infra", "docker", "data");
    const src = join(dataRoot, "gtfs");
    const tgt = join(dataRoot, "motis", "gtfs");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "feed-a.zip"), "A");
    writeFileSync(join(src, "feed-b.zip"), "B");

    applyHardlinkPlan(
      [
        {
          source: "data/gtfs",
          target: "data/motis/gtfs",
          consumerService: "motis",
          dataType: "gtfs",
        },
      ],
      { rootDir: dataRoot },
    );

    rmSync(join(src, "feed-b.zip"));
    // Container meanwhile wrote a cache file we must not touch.
    writeFileSync(join(tgt, "nigiri.cache"), "cache");

    const result = applyHardlinkPlan(
      [
        {
          source: "data/gtfs",
          target: "data/motis/gtfs",
          consumerService: "motis",
          dataType: "gtfs",
        },
      ],
      { rootDir: dataRoot },
    );

    expect(result.pruned).toBe(1);
    expect(existsSync(join(tgt, "feed-a.zip"))).toBe(true);
    expect(existsSync(join(tgt, "feed-b.zip"))).toBe(false);
    expect(existsSync(join(tgt, "nigiri.cache"))).toBe(true);
  });

  it("applyGeneratedHardlinks can no-op when plan is missing", () => {
    const result = applyGeneratedHardlinks({ rootDir: tmp, requirePlan: false });
    expect(result.applied).toBe(false);
    expect(result.linked).toBe(0);
    expect(result.pruned).toBe(0);
  });

  it("applyGeneratedHardlinks reads generated plan from infra/docker", () => {
    const dataRoot = join(tmp, "infra", "docker", "data");
    mkdirSync(join(dataRoot, "osm"), { recursive: true });
    writeFileSync(join(dataRoot, "osm", "planet.osm.pbf"), "PBF");
    mkdirSync(join(tmp, "infra", "docker"), { recursive: true });
    writeFileSync(
      join(tmp, "infra", "docker", "docker-compose.generated.hardlinks.json"),
      JSON.stringify([
        {
          source: "data/osm",
          target: "data/nominatim/osm-pbf",
          consumerService: "nominatim",
          dataType: "osm-pbf",
          targetFilename: "data.osm.pbf",
        },
      ]),
      "utf-8",
    );

    const result = applyGeneratedHardlinks({ rootDir: tmp, requirePlan: true, prune: true });

    expect(result.applied).toBe(true);
    expect(result.linked).toBe(1);
    expect(result.pruned).toBe(0);
    expect(readFileSync(join(dataRoot, "nominatim", "osm-pbf", "data.osm.pbf"), "utf-8")).toBe(
      "PBF",
    );
  });

  it("applyGeneratedHardlinks creates data root even with an empty plan", () => {
    const dataRoot = join(tmp, "infra", "docker", "data");
    rmSync(dataRoot, { recursive: true, force: true });
    writeFileSync(join(tmp, "infra", "docker", "docker-compose.generated.hardlinks.json"), "[]");

    const result = applyGeneratedHardlinks({ rootDir: tmp, requirePlan: true, prune: true });

    expect(result.applied).toBe(true);
    expect(result.linked).toBe(0);
    expect(result.pruned).toBe(0);
    expect(existsSync(dataRoot)).toBe(true);
    expect(statSync(dataRoot).isDirectory()).toBe(true);
  });
});

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyHardlinkPlan, SENTINEL_DIR } from "../src/index.js";

describe("applyHardlinkPlan", () => {
  let root: string;

  beforeEach(() => {
    root = join(tmpdir(), `openmapx-hl-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  it("links files from source into target and writes a sentinel", () => {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.txt"), "A");
    writeFileSync(join(root, "src", "b.txt"), "B");

    const result = applyHardlinkPlan(
      [{ source: "src", target: "tgt", consumerService: "svc", dataType: "data" }],
      { rootDir: root },
    );

    expect(result.linked).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.pruned).toBe(0);
    expect(readFileSync(join(root, "tgt", "a.txt"), "utf-8")).toBe("A");
    expect(readFileSync(join(root, "tgt", "b.txt"), "utf-8")).toBe("B");

    const sentinelPath = join(root, SENTINEL_DIR, "svc-data.json");
    expect(existsSync(sentinelPath)).toBe(true);
    const sentinel = JSON.parse(readFileSync(sentinelPath, "utf-8"));
    expect(sentinel.linkedPaths).toEqual(expect.arrayContaining(["a.txt", "b.txt"]));
  });

  it("skips already-linked files on second apply", () => {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.txt"), "A");

    const plan = [{ source: "src", target: "tgt", consumerService: "svc", dataType: "data" }];
    applyHardlinkPlan(plan, { rootDir: root });
    const second = applyHardlinkPlan(plan, { rootDir: root });

    expect(second.linked).toBe(0);
    expect(second.skipped).toBe(1);
    expect(second.pruned).toBe(0);
  });

  it("preserves container-written files inside the target dir", () => {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "input.pbf"), "pbf");

    const plan = [
      { source: "src", target: "tgt", consumerService: "valhalla", dataType: "osm-pbf" },
    ];
    applyHardlinkPlan(plan, { rootDir: root });

    // Simulate the consumer container writing output alongside the hardlinked input.
    writeFileSync(join(root, "tgt", "valhalla_tiles.tar"), "tiles");
    writeFileSync(join(root, "tgt", "admins.sqlite"), "admins");

    const second = applyHardlinkPlan(plan, { rootDir: root });

    expect(existsSync(join(root, "tgt", "valhalla_tiles.tar"))).toBe(true);
    expect(existsSync(join(root, "tgt", "admins.sqlite"))).toBe(true);
    expect(second.pruned).toBe(0);
  });

  it("prunes files we previously linked when the producer removes them", () => {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "feed-a.zip"), "a");
    writeFileSync(join(root, "src", "feed-b.zip"), "b");

    const plan = [
      { source: "src", target: "tgt", consumerService: "motis", dataType: "motis-data" },
    ];
    applyHardlinkPlan(plan, { rootDir: root });

    rmSync(join(root, "src", "feed-b.zip"));

    // Meanwhile the container wrote a cache file we must not touch.
    writeFileSync(join(root, "tgt", "nigiri.cache"), "cache");

    const second = applyHardlinkPlan(plan, { rootDir: root });

    expect(existsSync(join(root, "tgt", "feed-a.zip"))).toBe(true);
    expect(existsSync(join(root, "tgt", "feed-b.zip"))).toBe(false);
    expect(existsSync(join(root, "tgt", "nigiri.cache"))).toBe(true);
    expect(second.pruned).toBe(1);
  });

  it("rehardlinks when source inode changes", () => {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.txt"), "A1");

    const plan = [{ source: "src", target: "tgt", consumerService: "svc", dataType: "data" }];
    applyHardlinkPlan(plan, { rootDir: root });

    rmSync(join(root, "src", "a.txt"));
    writeFileSync(join(root, "src", "a.txt"), "A2");

    const second = applyHardlinkPlan(plan, { rootDir: root });

    expect(second.linked).toBe(1);
    expect(readFileSync(join(root, "tgt", "a.txt"), "utf-8")).toBe("A2");
  });

  it("handles nested directory layouts", () => {
    mkdirSync(join(root, "src", "sub"), { recursive: true });
    writeFileSync(join(root, "src", "top.txt"), "top");
    writeFileSync(join(root, "src", "sub", "inner.txt"), "inner");

    const plan = [{ source: "src", target: "tgt", consumerService: "svc", dataType: "data" }];
    const result = applyHardlinkPlan(plan, { rootDir: root });

    expect(result.linked).toBe(2);
    expect(existsSync(join(root, "tgt", "sub", "inner.txt"))).toBe(true);
  });

  it("links a single file under a stable filename when targetFilename is set", () => {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "germany-latest.osm.pbf"), "pbf");

    const plan = [
      {
        source: "src",
        target: "tgt",
        consumerService: "nominatim",
        dataType: "osm-pbf",
        targetFilename: "data.osm.pbf",
      },
    ];
    const result = applyHardlinkPlan(plan, { rootDir: root });

    expect(result.linked).toBe(1);
    expect(existsSync(join(root, "tgt", "data.osm.pbf"))).toBe(true);
  });

  it("rejects plans whose target is nested inside source", () => {
    mkdirSync(join(root, "a"), { recursive: true });
    writeFileSync(join(root, "a", "x.txt"), "x");

    expect(() =>
      applyHardlinkPlan(
        [{ source: "a", target: "a/inner", consumerService: "svc", dataType: "data" }],
        { rootDir: root },
      ),
    ).toThrow(/nested inside source/);
  });

  it("rejects plans whose source is nested inside target", () => {
    mkdirSync(join(root, "a", "inner"), { recursive: true });
    writeFileSync(join(root, "a", "inner", "x.txt"), "x");

    expect(() =>
      applyHardlinkPlan(
        [{ source: "a/inner", target: "a", consumerService: "svc", dataType: "data" }],
        { rootDir: root },
      ),
    ).toThrow(/nested inside target/);
  });

  it("rejects plans whose source escapes the root", () => {
    expect(() =>
      applyHardlinkPlan(
        [{ source: "../escape", target: "tgt", consumerService: "svc", dataType: "data" }],
        { rootDir: root },
      ),
    ).toThrow(/escapes the data root/);
  });

  it("prunes previously-linked paths when the producer source disappears", () => {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.txt"), "A");

    const plan = [{ source: "src", target: "tgt", consumerService: "svc", dataType: "data" }];
    applyHardlinkPlan(plan, { rootDir: root });

    writeFileSync(join(root, "tgt", "container-made.cache"), "cache");

    rmSync(join(root, "src"), { recursive: true, force: true });

    const second = applyHardlinkPlan(plan, { rootDir: root });

    expect(existsSync(join(root, "tgt", "a.txt"))).toBe(false);
    expect(existsSync(join(root, "tgt", "container-made.cache"))).toBe(true);
    expect(second.pruned).toBe(1);
  });

  it("does not prune when prune is false", () => {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.txt"), "A");

    const plan = [{ source: "src", target: "tgt", consumerService: "svc", dataType: "data" }];
    applyHardlinkPlan(plan, { rootDir: root });

    rmSync(join(root, "src", "a.txt"));

    const second = applyHardlinkPlan(plan, { rootDir: root, prune: false });

    expect(existsSync(join(root, "tgt", "a.txt"))).toBe(true);
    expect(second.pruned).toBe(0);
  });

  it("records instance in the sentinel filename", () => {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.txt"), "A");

    applyHardlinkPlan(
      [
        {
          source: "src",
          target: "tgt",
          consumerService: "svc",
          dataType: "data",
          instance: "europe",
        },
      ],
      { rootDir: root },
    );

    expect(existsSync(join(root, SENTINEL_DIR, "svc-data-europe.json"))).toBe(true);
  });

  it("strips a leading 'data/' segment from plan paths", () => {
    // The compose renderer emits plan paths relative to the compose project
    // directory (e.g. `data/osm`). When the rootDir *is* that `data` dir, the
    // leading segment must be stripped.
    mkdirSync(join(root, "osm"), { recursive: true });
    writeFileSync(join(root, "osm", "germany.pbf"), "pbf");

    const result = applyHardlinkPlan(
      [
        {
          source: "data/osm",
          target: "data/valhalla/osm-input",
          consumerService: "valhalla",
          dataType: "osm-pbf",
        },
      ],
      { rootDir: root },
    );

    expect(result.linked).toBe(1);
    expect(existsSync(join(root, "valhalla", "osm-input", "germany.pbf"))).toBe(true);
  });
});

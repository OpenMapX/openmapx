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
import { applyHardlinkPlan } from "../src/jobs/link.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "openmapx-link-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("applyHardlinkPlan", () => {
  it("hardlinks all files in source dir to target dir", async () => {
    const src = join(tmp, "src");
    const tgt = join(tmp, "tgt");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "a.osm.pbf"), "PBF1");
    writeFileSync(join(src, "b.osm.pbf"), "PBF2");

    const result = await applyHardlinkPlan(
      [{ source: src, target: tgt, consumerService: "valhalla", dataType: "osm-pbf" }],
      { rootDir: tmp },
    );

    expect(result.linked).toBe(2);
    expect(result.pruned).toBe(0);
    expect(readFileSync(join(tgt, "a.osm.pbf"), "utf-8")).toBe("PBF1");
    expect(statSync(join(src, "a.osm.pbf")).ino).toBe(statSync(join(tgt, "a.osm.pbf")).ino);
  });

  it("strips leading `data/` from plan paths and resolves against rootDir", async () => {
    // Simulates the real compose-renderer output: `source: "data/osm"`,
    // `target: "data/motis/osm-pbf"` — both resolved by applyHardlinkPlan
    // against `rootDir` = the data-manager's /data mount (which already IS
    // `infra/docker/data/`). Plain resolve would land at `/data/data/osm`,
    // which 404s the directory and silently links zero files.
    mkdirSync(join(tmp, "osm"), { recursive: true });
    writeFileSync(join(tmp, "osm", "a.osm.pbf"), "PBF");

    const result = await applyHardlinkPlan(
      [
        {
          source: "data/osm",
          target: "data/motis/osm-pbf",
          consumerService: "motis",
          dataType: "osm-pbf",
        },
      ],
      { rootDir: tmp },
    );
    expect(result.linked).toBe(1);
    expect(result.pruned).toBe(0);
    expect(statSync(join(tmp, "osm", "a.osm.pbf")).ino).toBe(
      statSync(join(tmp, "motis", "osm-pbf", "a.osm.pbf")).ino,
    );
  });

  it("recurses into nested subdirectories (tile-fonts / tile-styles layout)", async () => {
    // tile-fonts has per-fontstack subdirs (`Metropolis Bold/` etc.), each
    // with range .pbf files inside. tile-styles has per-style subdirs with
    // style.json + sprite.* siblings. A flat readdir would skip every entry
    // because each one is a directory.
    const src = join(tmp, "tile-styles");
    mkdirSync(join(src, "osm-bright"), { recursive: true });
    writeFileSync(join(src, "osm-bright", "style.json"), "{}");
    writeFileSync(join(src, "osm-bright", "sprite.png"), "PNG");
    mkdirSync(join(src, "dark-matter"), { recursive: true });
    writeFileSync(join(src, "dark-matter", "style.json"), "{}");

    const result = await applyHardlinkPlan(
      [
        {
          source: "tile-styles",
          target: "tileserver/tile-styles",
          consumerService: "tileserver",
          dataType: "tile-styles",
        },
      ],
      { rootDir: tmp },
    );
    expect(result.linked).toBe(3);
    expect(result.pruned).toBe(0);
    expect(
      readFileSync(join(tmp, "tileserver", "tile-styles", "osm-bright", "sprite.png"), "utf-8"),
    ).toBe("PNG");
  });

  it("skips re-link when inode already matches (idempotent)", async () => {
    const src = join(tmp, "src");
    const tgt = join(tmp, "tgt");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "a.osm.pbf"), "PBF");

    const r1 = await applyHardlinkPlan(
      [{ source: src, target: tgt, consumerService: "v", dataType: "osm-pbf" }],
      { rootDir: tmp },
    );
    expect(r1.linked).toBe(1);
    expect(r1.skipped).toBe(0);
    expect(r1.pruned).toBe(0);

    const r2 = await applyHardlinkPlan(
      [{ source: src, target: tgt, consumerService: "v", dataType: "osm-pbf" }],
      { rootDir: tmp },
    );
    expect(r2.linked).toBe(0);
    expect(r2.skipped).toBe(1);
    expect(r2.pruned).toBe(0);
  });

  it("replaces stale target files when the source inode changed", async () => {
    const src = join(tmp, "src");
    const tgt = join(tmp, "tgt");
    mkdirSync(src, { recursive: true });
    mkdirSync(tgt, { recursive: true });
    writeFileSync(join(src, "feed.zip"), "fresh");
    writeFileSync(join(tgt, "feed.zip"), "stale");

    const result = await applyHardlinkPlan(
      [{ source: src, target: tgt, consumerService: "motis", dataType: "gtfs" }],
      { rootDir: tmp },
    );

    expect(result.linked).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.pruned).toBe(1);
    expect(readFileSync(join(tgt, "feed.zip"), "utf-8")).toBe("fresh");
    expect(statSync(join(src, "feed.zip")).ino).toBe(statSync(join(tgt, "feed.zip")).ino);
  });

  it("links exactly one source file under a requested target filename", async () => {
    const src = join(tmp, "osm");
    const tgt = join(tmp, "nominatim", "osm-pbf");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "europe-germany.osm.pbf"), "PBF");

    const result = await applyHardlinkPlan(
      [
        {
          source: src,
          target: tgt,
          consumerService: "nominatim",
          dataType: "osm-pbf",
          targetFilename: "data.osm.pbf",
        },
      ],
      { rootDir: tmp },
    );

    expect(result.linked).toBe(1);
    expect(result.pruned).toBe(0);
    expect(readFileSync(join(tgt, "data.osm.pbf"), "utf-8")).toBe("PBF");
    expect(statSync(join(src, "europe-germany.osm.pbf")).ino).toBe(
      statSync(join(tgt, "data.osm.pbf")).ino,
    );
  });

  it("fails a targetFilename link when the source directory has multiple files", async () => {
    const src = join(tmp, "osm");
    const tgt = join(tmp, "nominatim", "osm-pbf");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "europe-germany.osm.pbf"), "PBF1");
    writeFileSync(join(src, "planet.osm.pbf"), "PBF2");

    await expect(
      applyHardlinkPlan(
        [
          {
            source: src,
            target: tgt,
            consumerService: "nominatim",
            dataType: "osm-pbf",
            targetFilename: "data.osm.pbf",
          },
        ],
        { rootDir: tmp },
      ),
    ).rejects.toThrow(/expected exactly one source file/);
  });

  it("prunes stale target files that no longer exist in source", async () => {
    const src = join(tmp, "src");
    const tgt = join(tmp, "tgt");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "feed.zip"), "GTFS");

    await applyHardlinkPlan(
      [{ source: src, target: tgt, consumerService: "motis", dataType: "gtfs" }],
      { rootDir: tmp },
    );
    rmSync(join(src, "feed.zip"), { force: true });

    const result = await applyHardlinkPlan(
      [{ source: src, target: tgt, consumerService: "motis", dataType: "gtfs" }],
      { rootDir: tmp },
    );

    expect(result.linked).toBe(0);
    expect(result.pruned).toBe(1);
    expect(existsSync(join(tgt, "feed.zip"))).toBe(false);
  });

  it("can keep stale target files when prune is disabled", async () => {
    const src = join(tmp, "src");
    const tgt = join(tmp, "tgt");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "feed.zip"), "GTFS");

    await applyHardlinkPlan(
      [{ source: src, target: tgt, consumerService: "motis", dataType: "gtfs" }],
      { rootDir: tmp },
    );
    rmSync(join(src, "feed.zip"), { force: true });

    const result = await applyHardlinkPlan(
      [{ source: src, target: tgt, consumerService: "motis", dataType: "gtfs" }],
      { rootDir: tmp, prune: false },
    );

    expect(result.linked).toBe(0);
    expect(result.pruned).toBe(0);
    expect(existsSync(join(tgt, "feed.zip"))).toBe(true);
  });

  it("rejects source paths that escape rootDir", async () => {
    const src = join(tmp, "src");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "a"), "data");

    await expect(
      applyHardlinkPlan(
        [
          {
            source: "../etc/passwd",
            target: "valid",
            consumerService: "x",
            dataType: "osm",
          },
        ],
        { rootDir: tmp },
      ),
    ).rejects.toThrow(/escapes the data root/);
  });

  it("rejects target paths that escape rootDir", async () => {
    const src = join(tmp, "src");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "a"), "data");

    await expect(
      applyHardlinkPlan(
        [
          {
            source: "src",
            target: "/tmp/elsewhere",
            consumerService: "x",
            dataType: "osm",
          },
        ],
        { rootDir: tmp },
      ),
    ).rejects.toThrow(/escapes the data root/);
  });
});

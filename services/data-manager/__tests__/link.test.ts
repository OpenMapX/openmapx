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
    // `target: "data/motis/osm-input"` — both resolved by applyHardlinkPlan
    // against `rootDir` = the data-manager's /data mount (which already IS
    // `infra/docker/data/`). Plain resolve would land at `/data/data/osm`,
    // which 404s the directory and silently links zero files.
    mkdirSync(join(tmp, "osm"), { recursive: true });
    writeFileSync(join(tmp, "osm", "a.osm.pbf"), "PBF");

    const result = await applyHardlinkPlan(
      [
        {
          source: "data/osm",
          target: "data/motis/osm-input",
          consumerService: "motis",
          dataType: "osm-pbf",
        },
      ],
      { rootDir: tmp },
    );
    expect(result.linked).toBe(1);
    expect(result.pruned).toBe(0);
    expect(statSync(join(tmp, "osm", "a.osm.pbf")).ino).toBe(
      statSync(join(tmp, "motis", "osm-input", "a.osm.pbf")).ino,
    );
  });

  it("recurses into nested tile-font stack directories", async () => {
    const src = join(tmp, "tile-fonts");
    mkdirSync(join(src, "Metropolis Bold"), { recursive: true });
    writeFileSync(join(src, "Metropolis Bold", "0-255.pbf"), "PBF");
    writeFileSync(join(src, "Metropolis Bold", "256-511.pbf"), "PBF");
    mkdirSync(join(src, "Noto Sans Regular"), { recursive: true });
    writeFileSync(join(src, "Noto Sans Regular", "0-255.pbf"), "PBF");

    const result = await applyHardlinkPlan(
      [
        {
          source: "tile-fonts",
          target: "tileserver/tile-fonts",
          consumerService: "tileserver",
          dataType: "tile-fonts",
        },
      ],
      { rootDir: tmp },
    );
    expect(result.linked).toBe(3);
    expect(result.pruned).toBe(0);
    expect(
      readFileSync(join(tmp, "tileserver", "tile-fonts", "Metropolis Bold", "0-255.pbf"), "utf-8"),
    ).toBe("PBF");
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

  it("re-links same-named files when the source inode changes", async () => {
    const src = join(tmp, "src");
    const tgt = join(tmp, "tgt");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "feed.zip"), "A");

    await applyHardlinkPlan(
      [{ source: src, target: tgt, consumerService: "motis", dataType: "gtfs" }],
      { rootDir: tmp },
    );

    // Producer replaces the file atomically → new inode.
    rmSync(join(src, "feed.zip"));
    writeFileSync(join(src, "feed.zip"), "B");

    const result = await applyHardlinkPlan(
      [{ source: src, target: tgt, consumerService: "motis", dataType: "gtfs" }],
      { rootDir: tmp },
    );

    expect(result.linked).toBe(1);
    expect(readFileSync(join(tgt, "feed.zip"), "utf-8")).toBe("B");
    expect(statSync(join(src, "feed.zip")).ino).toBe(statSync(join(tgt, "feed.zip")).ino);
  });

  it("preserves files the container wrote into the consumer mount", async () => {
    const src = join(tmp, "src");
    const tgt = join(tmp, "tgt");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "input.pbf"), "PBF");

    await applyHardlinkPlan(
      [{ source: src, target: tgt, consumerService: "valhalla", dataType: "osm-pbf" }],
      { rootDir: tmp },
    );

    // Simulate container output — this is the file valhalla writes after
    // building tiles. It must survive subsequent link applies.
    writeFileSync(join(tgt, "valhalla_tiles.tar"), "tiles");
    writeFileSync(join(tgt, "admins.sqlite"), "admins");

    const result = await applyHardlinkPlan(
      [{ source: src, target: tgt, consumerService: "valhalla", dataType: "osm-pbf" }],
      { rootDir: tmp },
    );

    expect(result.pruned).toBe(0);
    expect(existsSync(join(tgt, "valhalla_tiles.tar"))).toBe(true);
    expect(existsSync(join(tgt, "admins.sqlite"))).toBe(true);
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

  it("prunes only target files we previously linked and that are gone from source", async () => {
    const src = join(tmp, "src");
    const tgt = join(tmp, "tgt");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "feed.zip"), "GTFS");

    await applyHardlinkPlan(
      [{ source: src, target: tgt, consumerService: "motis", dataType: "gtfs" }],
      { rootDir: tmp },
    );

    // Container writes its own file that was never linked — must survive.
    writeFileSync(join(tgt, "nigiri.cache"), "cache");
    rmSync(join(src, "feed.zip"), { force: true });

    const result = await applyHardlinkPlan(
      [{ source: src, target: tgt, consumerService: "motis", dataType: "gtfs" }],
      { rootDir: tmp },
    );

    expect(result.linked).toBe(0);
    expect(result.pruned).toBe(1);
    expect(existsSync(join(tgt, "feed.zip"))).toBe(false);
    expect(existsSync(join(tgt, "nigiri.cache"))).toBe(true);
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

  it("rejects plans whose target is nested inside source", async () => {
    const src = join(tmp, "a");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "x"), "x");

    await expect(
      applyHardlinkPlan(
        [{ source: "a", target: "a/inner", consumerService: "svc", dataType: "data" }],
        { rootDir: tmp },
      ),
    ).rejects.toThrow(/nested inside source/);
  });
});

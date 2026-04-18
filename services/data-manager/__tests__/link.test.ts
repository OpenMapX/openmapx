import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
    expect(readFileSync(join(tgt, "a.osm.pbf"), "utf-8")).toBe("PBF1");
    expect(statSync(join(src, "a.osm.pbf")).ino).toBe(statSync(join(tgt, "a.osm.pbf")).ino);
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

    const r2 = await applyHardlinkPlan(
      [{ source: src, target: tgt, consumerService: "v", dataType: "osm-pbf" }],
      { rootDir: tmp },
    );
    expect(r2.linked).toBe(0);
    expect(r2.skipped).toBe(1);
  });
});

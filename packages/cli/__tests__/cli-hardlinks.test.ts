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
  it("links files and prunes stale target files by default", () => {
    const src = join(tmp, "infra", "docker", "data", "osm");
    const tgt = join(tmp, "infra", "docker", "data", "valhalla", "osm-pbf");
    mkdirSync(src, { recursive: true });
    mkdirSync(tgt, { recursive: true });
    writeFileSync(join(src, "region.osm.pbf"), "fresh");
    writeFileSync(join(tgt, "obsolete.osm.pbf"), "stale");

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

    expect(result).toEqual({ linked: 1, skipped: 0, pruned: 1 });
    expect(readFileSync(join(tgt, "region.osm.pbf"), "utf-8")).toBe("fresh");
    expect(statSync(join(src, "region.osm.pbf")).ino).toBe(
      statSync(join(tgt, "region.osm.pbf")).ino,
    );
    expect(existsSync(join(tgt, "obsolete.osm.pbf"))).toBe(false);
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

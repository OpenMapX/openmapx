import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildTileMbtiles,
  type CommandRunner,
  DEFAULT_PLANETILER_IMAGE,
  DEFAULT_PLANETILER_JAVA_TOOL_OPTIONS,
  TILE_MBTILES_DIR,
  TILE_MBTILES_FILENAME,
} from "../src/lib/tile-mbtiles";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "openmapx-tile-mbtiles-"));
  writeFileSync(join(tmp, "pnpm-workspace.yaml"), "packages: []\n");
  mkdirSync(join(tmp, "services"), { recursive: true });
  mkdirSync(join(tmp, "infra", "docker", "data", "osm"), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("buildTileMbtiles", () => {
  it("runs Planetiler against the selected OSM PBF and writes tiles.mbtiles", async () => {
    const pbf = join(tmp, "infra", "docker", "data", "osm", "europe-germany.osm.pbf");
    writeFileSync(pbf, "PBF");

    const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
    const outputDir = join(tmp, "infra", "docker", "data", TILE_MBTILES_DIR);
    const runner: CommandRunner = async (command, args, opts) => {
      calls.push({ command, args, cwd: opts.cwd });
      writeFileSync(join(outputDir, TILE_MBTILES_FILENAME), "MBTILES");
    };

    const result = await buildTileMbtiles({
      rootDir: tmp,
      region: "europe/germany",
      runner,
    });

    expect(result.mbtilesPath).toBe(join(outputDir, TILE_MBTILES_FILENAME));
    expect(existsSync(result.mbtilesPath)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cwd).toBe(join(tmp, "infra", "docker"));
    expect(calls[0]?.args).toEqual([
      "run",
      "--rm",
      "-e",
      `JAVA_TOOL_OPTIONS=${DEFAULT_PLANETILER_JAVA_TOOL_OPTIONS}`,
      "-v",
      `${join(tmp, "infra", "docker", "data", "osm")}:/osm:ro`,
      "-v",
      `${outputDir}:/output`,
      DEFAULT_PLANETILER_IMAGE,
      "--download",
      "--osm-path=/osm/europe-germany.osm.pbf",
      `--output=/output/${TILE_MBTILES_FILENAME}`,
      "--nodemap-type=array",
      "--force",
    ]);
  });

  it("requires region disambiguation when multiple PBF files exist", async () => {
    const osmDir = join(tmp, "infra", "docker", "data", "osm");
    writeFileSync(join(osmDir, "europe-germany.osm.pbf"), "PBF");
    writeFileSync(join(osmDir, "planet.osm.pbf"), "PBF");

    await expect(buildTileMbtiles({ rootDir: tmp, runner: async () => {} })).rejects.toThrow(
      /Multiple OSM PBF files/,
    );
  });
});

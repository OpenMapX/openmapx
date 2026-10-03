import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildTileMbtiles,
  type CommandRunner,
  defaultPlanetilerJavaToolOptions,
  PLANET_PLANETILER_JAVA_TOOL_OPTIONS,
  PLANETILER_JAVA_TOOL_OPTIONS_ENV,
  PLANETILER_WORK_DIR,
  PLANETILER_WORK_DIR_ENV,
  TILE_MBTILES_DIR,
  TILE_MBTILES_FILENAME,
} from "../src/lib/tile-mbtiles";

const IMAGE = "ghcr.io/onthegomap/planetiler:0.10.2@sha256:abc";

let tmp: string;
let dataDir: string;

beforeEach(() => {
  delete process.env[PLANETILER_JAVA_TOOL_OPTIONS_ENV];
  delete process.env[PLANETILER_WORK_DIR_ENV];
  tmp = mkdtempSync(join(tmpdir(), "openmapx-tile-mbtiles-"));
  dataDir = join(tmp, "infra", "docker", "data");
  writeFileSync(join(tmp, "pnpm-workspace.yaml"), "packages: []\n");
  mkdirSync(join(tmp, "services"), { recursive: true });
  mkdirSync(join(dataDir, "osm"), { recursive: true });
});

afterEach(() => {
  delete process.env[PLANETILER_JAVA_TOOL_OPTIONS_ENV];
  delete process.env[PLANETILER_WORK_DIR_ENV];
  rmSync(tmp, { recursive: true, force: true });
});

function userArgs(): string[] {
  if (typeof process.getuid !== "function" || typeof process.getgid !== "function") return [];
  return ["--user", `${process.getuid()}:${process.getgid()}`];
}

/** Writes the archive into whatever `/output` is mounted from. */
function writingRunner(calls: string[][]): CommandRunner {
  return async (_command, args) => {
    calls.push(args);
    const output = args.find((arg) => arg.endsWith(":/output"))?.replace(/:\/output$/, "");
    if (output) writeFileSync(join(output, TILE_MBTILES_FILENAME), "MBTILES");
  };
}

describe("buildTileMbtiles", () => {
  it("builds an extract into a staged dir with a persistent work dir and Planetiler defaults", async () => {
    writeFileSync(join(dataDir, "osm", "europe-germany.osm.pbf"), "PBF");
    const outputDir = join(dataDir, TILE_MBTILES_DIR);
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(join(outputDir, TILE_MBTILES_FILENAME), "OLD");

    const calls: string[][] = [];
    const result = await buildTileMbtiles({
      rootDir: tmp,
      region: "europe/germany",
      image: IMAGE,
      runner: writingRunner(calls),
    });

    const workDir = join(dataDir, PLANETILER_WORK_DIR);
    expect(calls).toEqual([
      [
        "run",
        "--rm",
        "--name",
        "openmapx-build-tileserver",
        ...userArgs(),
        "-e",
        "JAVA_TOOL_OPTIONS=-Xmx2g",
        "-v",
        `${join(dataDir, "osm")}:/osm:ro`,
        "-v",
        `${outputDir}.next:/output`,
        "-v",
        `${workDir}:/work`,
        IMAGE,
        "--download",
        "--download-dir=/work/sources",
        "--tmpdir=/work/tmp",
        "--osm-path=/osm/europe-germany.osm.pbf",
        `--output=/output/${TILE_MBTILES_FILENAME}`,
        "--force",
      ],
    ]);
    expect(readFileSync(result.mbtilesPath, "utf-8")).toBe("MBTILES");
    expect(existsSync(`${outputDir}.next`)).toBe(false);
    expect(existsSync(workDir)).toBe(true);
    expect(result).toMatchObject({ javaToolOptions: "-Xmx2g", workDir, image: IMAGE });
  });

  it("uses the array node map and fixed heap only for the planet", async () => {
    writeFileSync(join(dataDir, "osm", "planet.osm.pbf"), "PBF");
    const calls: string[][] = [];
    await buildTileMbtiles({
      rootDir: tmp,
      region: "planet",
      image: IMAGE,
      runner: writingRunner(calls),
    });
    expect(calls[0]).toContain("--nodemap-type=array");
    expect(calls[0]).toContain(`JAVA_TOOL_OPTIONS=${PLANET_PLANETILER_JAVA_TOOL_OPTIONS}`);
  });

  it("takes heap and work dir overrides from the environment", async () => {
    writeFileSync(join(dataDir, "osm", "europe-germany.osm.pbf"), "PBF");
    const scratch = join(tmp, "scratch-disk");
    process.env[PLANETILER_JAVA_TOOL_OPTIONS_ENV] = "-Xmx9g";
    process.env[PLANETILER_WORK_DIR_ENV] = scratch;
    const calls: string[][] = [];
    await buildTileMbtiles({ rootDir: tmp, image: IMAGE, runner: writingRunner(calls) });
    expect(calls[0]).toContain("JAVA_TOOL_OPTIONS=-Xmx9g");
    expect(calls[0]).toContain(`${scratch}:/work`);
    expect(existsSync(scratch)).toBe(true);
  });

  it("scales the extract heap to half the PBF size", () => {
    const pbf = join(dataDir, "osm", "big.osm.pbf");
    writeFileSync(pbf, "");
    // Sparse, so the test doesn't write 9 GiB.
    truncateSync(pbf, 9 * 1024 ** 3);
    expect(defaultPlanetilerJavaToolOptions(pbf)).toBe("-Xmx5g");
  });

  it("keeps the previous archive when Planetiler fails", async () => {
    writeFileSync(join(dataDir, "osm", "europe-germany.osm.pbf"), "PBF");
    const outputDir = join(dataDir, TILE_MBTILES_DIR);
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(join(outputDir, TILE_MBTILES_FILENAME), "OLD");

    await expect(
      buildTileMbtiles({
        rootDir: tmp,
        image: IMAGE,
        runner: async () => {
          throw new Error("planetiler exited 137");
        },
      }),
    ).rejects.toThrow(/exited 137/);
    expect(readFileSync(join(outputDir, TILE_MBTILES_FILENAME), "utf-8")).toBe("OLD");
    expect(existsSync(`${outputDir}.next`)).toBe(false);
  });

  it("requires region disambiguation when multiple PBF files exist", async () => {
    writeFileSync(join(dataDir, "osm", "europe-germany.osm.pbf"), "PBF");
    writeFileSync(join(dataDir, "osm", "planet.osm.pbf"), "PBF");

    await expect(
      buildTileMbtiles({ rootDir: tmp, image: IMAGE, runner: async () => {} }),
    ).rejects.toThrow(/Multiple OSM PBF files/);
  });
});

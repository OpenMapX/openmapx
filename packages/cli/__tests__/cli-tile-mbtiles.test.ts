import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STREET_DETAIL_SCHEMA } from "../src/lib/street-detail-schema";
import {
  buildTileMbtiles,
  type CommandRunner,
  defaultPlanetilerJavaToolOptions,
  PLANET_PLANETILER_JAVA_TOOL_OPTIONS,
  PLANETILER_JAVA_TOOL_OPTIONS_ENV,
  PLANETILER_WORK_DIR,
  PLANETILER_WORK_DIR_ENV,
  STREET_DETAIL_MBTILES_FILENAME,
  TILE_MBTILES_DIR,
  TILE_MBTILES_FILENAME,
  TILESERVER_BASEMAP_ENV,
  tileserverBasemapMode,
} from "../src/lib/tile-mbtiles";

const IMAGE = "ghcr.io/onthegomap/planetiler:0.10.2@sha256:abc";

let tmp: string;
let dataDir: string;

beforeEach(() => {
  delete process.env[PLANETILER_JAVA_TOOL_OPTIONS_ENV];
  delete process.env[PLANETILER_WORK_DIR_ENV];
  delete process.env[TILESERVER_BASEMAP_ENV];
  tmp = mkdtempSync(join(tmpdir(), "openmapx-tile-mbtiles-"));
  dataDir = join(tmp, "infra", "docker", "data");
  writeFileSync(join(tmp, "pnpm-workspace.yaml"), "packages: []\n");
  mkdirSync(join(tmp, "services"), { recursive: true });
  mkdirSync(join(dataDir, "osm"), { recursive: true });
});

afterEach(() => {
  delete process.env[PLANETILER_JAVA_TOOL_OPTIONS_ENV];
  delete process.env[PLANETILER_WORK_DIR_ENV];
  delete process.env[TILESERVER_BASEMAP_ENV];
  rmSync(tmp, { recursive: true, force: true });
});

function userArgs(): string[] {
  if (typeof process.getuid !== "function" || typeof process.getgid !== "function") return [];
  return ["--user", `${process.getuid()}:${process.getgid()}`];
}

/** Writes each run's archive (named by `--output=/output/…`) into whatever `/output` is mounted from. */
function writingRunner(calls: string[][]): CommandRunner {
  return async (_command, args) => {
    calls.push(args);
    const output = args.find((arg) => arg.endsWith(":/output"))?.replace(/:\/output$/, "");
    const name = args.find((arg) => arg.startsWith("--output=/output/"))?.slice(17);
    if (output && name) writeFileSync(join(output, name), name);
  };
}

function streetDetailArgs(outputDir: string, workDir: string, pbf: string, planet = false) {
  return [
    "run",
    "--rm",
    "--name",
    "openmapx-build-street-detail",
    ...userArgs(),
    "-e",
    planet
      ? `JAVA_TOOL_OPTIONS=${PLANET_PLANETILER_JAVA_TOOL_OPTIONS}`
      : "JAVA_TOOL_OPTIONS=-Xmx2g",
    "-v",
    `${join(dataDir, "osm")}:/osm:ro`,
    "-v",
    `${outputDir}.next:/output`,
    "-v",
    `${workDir}:/work`,
    IMAGE,
    "generate-custom",
    "--schema=/work/street-detail.yml",
    `--osm-path=/osm/${pbf}`,
    `--output=/output/${STREET_DETAIL_MBTILES_FILENAME}`,
    "--tmpdir=/work/tmp-street-detail",
    ...(planet ? ["--nodemap-type=array"] : []),
    "--force",
  ];
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
    expect(calls).toHaveLength(2);
    expect(calls.slice(0, 1)).toEqual([
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
    expect(calls[1]).toEqual(streetDetailArgs(outputDir, workDir, "europe-germany.osm.pbf"));
    expect(result.files).toEqual([
      join(outputDir, TILE_MBTILES_FILENAME),
      join(outputDir, STREET_DETAIL_MBTILES_FILENAME),
    ]);
    expect(readFileSync(join(outputDir, TILE_MBTILES_FILENAME), "utf-8")).toBe(
      TILE_MBTILES_FILENAME,
    );
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
    expect(calls[1]).toEqual(
      streetDetailArgs(
        join(dataDir, TILE_MBTILES_DIR),
        join(dataDir, PLANETILER_WORK_DIR),
        "planet.osm.pbf",
        true,
      ),
    );
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

  it("writes the schema and wipes stale street detail temp files before its run", async () => {
    writeFileSync(join(dataDir, "osm", "europe-germany.osm.pbf"), "PBF");
    const workDir = join(dataDir, PLANETILER_WORK_DIR);
    mkdirSync(join(workDir, "tmp-street-detail"), { recursive: true });
    writeFileSync(join(workDir, "tmp-street-detail", "stale"), "x");
    const seen: Array<{ schema: string; stale: boolean }> = [];
    const calls: string[][] = [];
    const write = writingRunner(calls);
    await buildTileMbtiles({
      rootDir: tmp,
      image: IMAGE,
      runner: async (command, args, opts) => {
        if (args.includes("generate-custom"))
          seen.push({
            schema: readFileSync(join(workDir, "street-detail.yml"), "utf8"),
            stale: existsSync(join(workDir, "tmp-street-detail", "stale")),
          });
        await write(command, args, opts);
      },
    });
    expect(seen).toEqual([{ schema: STREET_DETAIL_SCHEMA, stale: false }]);
  });

  it.each(["hosted", " Hosted "])(
    "builds only street detail with %j and drops an earlier basemap file",
    async (mode) => {
      writeFileSync(join(dataDir, "osm", "europe-germany.osm.pbf"), "PBF");
      const outputDir = join(dataDir, TILE_MBTILES_DIR);
      mkdirSync(outputDir, { recursive: true });
      writeFileSync(join(outputDir, TILE_MBTILES_FILENAME), "OLD");
      process.env[TILESERVER_BASEMAP_ENV] = mode;
      const calls: string[][] = [];
      const result = await buildTileMbtiles({
        rootDir: tmp,
        image: IMAGE,
        runner: writingRunner(calls),
      });
      expect(calls).toEqual([
        streetDetailArgs(outputDir, join(dataDir, PLANETILER_WORK_DIR), "europe-germany.osm.pbf"),
      ]);
      expect(readdirSync(outputDir)).toEqual([STREET_DETAIL_MBTILES_FILENAME]);
      expect(result.files).toEqual([join(outputDir, STREET_DETAIL_MBTILES_FILENAME)]);
    },
  );

  it("builds the basemap first with an explicit build mode", async () => {
    writeFileSync(join(dataDir, "osm", "europe-germany.osm.pbf"), "PBF");
    process.env[TILESERVER_BASEMAP_ENV] = "build";
    const calls: string[][] = [];
    await buildTileMbtiles({ rootDir: tmp, image: IMAGE, runner: writingRunner(calls) });
    expect(calls.map((args) => args[3])).toEqual([
      "openmapx-build-tileserver",
      "openmapx-build-street-detail",
    ]);
  });

  it("refuses an unknown basemap mode before starting any container", async () => {
    writeFileSync(join(dataDir, "osm", "europe-germany.osm.pbf"), "PBF");
    process.env[TILESERVER_BASEMAP_ENV] = "maybe";
    const calls: string[][] = [];
    await expect(
      buildTileMbtiles({ rootDir: tmp, image: IMAGE, runner: writingRunner(calls) }),
    ).rejects.toThrow(/TILESERVER_BASEMAP.*"build".*"hosted"/);
    expect(calls).toEqual([]);
  });

  it("reads the basemap mode from the environment", () => {
    expect(tileserverBasemapMode({})).toBe("build");
    expect(tileserverBasemapMode({ [TILESERVER_BASEMAP_ENV]: "" })).toBe("build");
    expect(tileserverBasemapMode({ [TILESERVER_BASEMAP_ENV]: "BUILD" })).toBe("build");
    expect(tileserverBasemapMode({ [TILESERVER_BASEMAP_ENV]: " hosted\n" })).toBe("hosted");
    expect(() => tileserverBasemapMode({ [TILESERVER_BASEMAP_ENV]: "self" })).toThrow();
  });

  it("keeps the previous archives when the street detail run fails", async () => {
    writeFileSync(join(dataDir, "osm", "europe-germany.osm.pbf"), "PBF");
    const outputDir = join(dataDir, TILE_MBTILES_DIR);
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(join(outputDir, TILE_MBTILES_FILENAME), "OLD");
    const calls: string[][] = [];
    const write = writingRunner(calls);
    await expect(
      buildTileMbtiles({
        rootDir: tmp,
        image: IMAGE,
        runner: async (command, args, opts) => {
          if (args.includes("generate-custom")) throw new Error("street detail exited 1");
          await write(command, args, opts);
        },
      }),
    ).rejects.toThrow(/exited 1/);
    expect(readdirSync(outputDir)).toEqual([TILE_MBTILES_FILENAME]);
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

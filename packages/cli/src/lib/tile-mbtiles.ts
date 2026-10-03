import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { execa } from "execa";
import { withStagedBuildDir } from "./build-staging";
import { resolveOsmPbf } from "./osm-pbf";
import { repoPaths, resolveInvocationPath } from "./paths";

export const TILE_MBTILES_DIR = "tile-mbtiles";
export const TILE_MBTILES_FILENAME = "tiles.mbtiles";
export const PLANETILER_WORK_DIR = "planetiler";
export const PLANETILER_JAVA_TOOL_OPTIONS_ENV = "PLANETILER_JAVA_TOOL_OPTIONS";
export const PLANETILER_WORK_DIR_ENV = "PLANETILER_WORK_DIR";
export const PLANET_PLANETILER_JAVA_TOOL_OPTIONS = "-Xmx30g";

const GIB = 1024 ** 3;

export type CommandRunner = (
  command: string,
  args: string[],
  opts: { cwd?: string; stdio?: "inherit" },
) => Promise<void>;

export interface BuildTileMbtilesOptions {
  rootDir?: string;
  region?: string;
  image: string;
  javaToolOptions?: string;
  /** Host dir for Planetiler's source downloads and temp files. */
  workDir?: string;
  runner?: CommandRunner;
}

export interface BuildTileMbtilesResult {
  sourcePbf: string;
  outputDir: string;
  mbtilesPath: string;
  image: string;
  javaToolOptions: string;
  workDir: string;
}

async function defaultRunner(
  command: string,
  args: string[],
  opts: { cwd?: string; stdio?: "inherit" },
): Promise<void> {
  await execa(command, args, { cwd: opts.cwd, stdio: opts.stdio ?? "inherit" });
}

function isPlanet(sourcePbf: string): boolean {
  return basename(sourcePbf) === "planet.osm.pbf";
}

/**
 * Planetiler's guidance for extracts is a heap of about half the input PBF,
 * leaving the rest of RAM to its memory-mapped temp storage. The planet keeps
 * the fixed heap Planetiler documents for its `array` node map.
 */
export function defaultPlanetilerJavaToolOptions(sourcePbf: string): string {
  if (isPlanet(sourcePbf)) return PLANET_PLANETILER_JAVA_TOOL_OPTIONS;
  const heapGib = Math.max(2, Math.ceil(statSync(sourcePbf).size / GIB / 2));
  return `-Xmx${heapGib}g`;
}

function dockerUserArgs(): string[] {
  if (typeof process.getuid !== "function" || typeof process.getgid !== "function") return [];
  return ["--user", `${process.getuid()}:${process.getgid()}`];
}

function dockerPlanetilerArgs(opts: {
  osmDir: string;
  outputDir: string;
  workDir: string;
  image: string;
  pbfName: string;
  javaToolOptions: string;
  planet: boolean;
}): string[] {
  return [
    "run",
    "--rm",
    "--name",
    "openmapx-build-tileserver",
    ...dockerUserArgs(),
    "-e",
    `JAVA_TOOL_OPTIONS=${opts.javaToolOptions}`,
    "-v",
    `${opts.osmDir}:/osm:ro`,
    "-v",
    `${opts.outputDir}:/output`,
    "-v",
    `${opts.workDir}:/work`,
    opts.image,
    "--download",
    "--download-dir=/work/sources",
    "--tmpdir=/work/tmp",
    `--osm-path=/osm/${opts.pbfName}`,
    `--output=/output/${TILE_MBTILES_FILENAME}`,
    // `array` sizes the node map by the highest OSM node id, which only pays
    // off for the planet; extracts use Planetiler's default `sparsearray`.
    ...(opts.planet ? ["--nodemap-type=array"] : []),
    "--force",
  ];
}

export async function buildTileMbtiles(
  opts: BuildTileMbtilesOptions,
): Promise<BuildTileMbtilesResult> {
  const paths = repoPaths(opts.rootDir);
  const dataDir = join(paths.infraDir, "data");
  const osmDir = join(dataDir, "osm");
  const outputDir = resolve(dataDir, TILE_MBTILES_DIR);
  const sourcePbf = resolveOsmPbf(dataDir, opts.region, "TileServer MBTiles");
  const javaToolOptions =
    opts.javaToolOptions ||
    process.env[PLANETILER_JAVA_TOOL_OPTIONS_ENV]?.trim() ||
    defaultPlanetilerJavaToolOptions(sourcePbf);
  const workDirEnv = process.env[PLANETILER_WORK_DIR_ENV]?.trim();
  const workDir = resolve(
    opts.workDir ||
      (workDirEnv ? resolveInvocationPath(workDirEnv) : join(dataDir, PLANETILER_WORK_DIR)),
  );
  const runner = opts.runner ?? defaultRunner;
  // Sources are reused across builds; temp files from a killed run are not.
  rmSync(join(workDir, "tmp"), { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });

  await withStagedBuildDir(outputDir, async (nextDir) => {
    await runner(
      "docker",
      dockerPlanetilerArgs({
        osmDir,
        outputDir: nextDir,
        workDir,
        image: opts.image,
        pbfName: basename(sourcePbf),
        javaToolOptions,
        planet: isPlanet(sourcePbf),
      }),
      { cwd: paths.infraDir, stdio: "inherit" },
    );
    if (!existsSync(join(nextDir, TILE_MBTILES_FILENAME))) {
      throw new Error(`Tile build finished but did not create ${TILE_MBTILES_FILENAME}`);
    }
  });

  return {
    sourcePbf,
    outputDir,
    mbtilesPath: join(outputDir, TILE_MBTILES_FILENAME),
    image: opts.image,
    javaToolOptions,
    workDir,
  };
}

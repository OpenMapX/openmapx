import { existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { execa } from "execa";
import { resolveOsmPbf } from "./osm-pbf";
import { repoPaths } from "./paths";

export const TILE_MBTILES_DIR = "tile-mbtiles";
export const TILE_MBTILES_FILENAME = "tiles.mbtiles";
export const DEFAULT_PLANETILER_IMAGE = "ghcr.io/onthegomap/planetiler:latest";
export const DEFAULT_PLANETILER_JAVA_TOOL_OPTIONS = "-Xmx30g";

export type CommandRunner = (
  command: string,
  args: string[],
  opts: { cwd?: string; stdio?: "inherit" },
) => Promise<void>;

export interface BuildTileMbtilesOptions {
  rootDir?: string;
  region?: string;
  image?: string;
  javaToolOptions?: string;
  runner?: CommandRunner;
}

export interface BuildTileMbtilesResult {
  sourcePbf: string;
  outputDir: string;
  mbtilesPath: string;
  image: string;
  javaToolOptions: string;
}

async function defaultRunner(
  command: string,
  args: string[],
  opts: { cwd?: string; stdio?: "inherit" },
): Promise<void> {
  await execa(command, args, { cwd: opts.cwd, stdio: opts.stdio ?? "inherit" });
}

function clearPreviousMbtiles(outputDir: string): void {
  mkdirSync(outputDir, { recursive: true });
  rmSync(join(outputDir, TILE_MBTILES_FILENAME), { force: true });
}

function dockerPlanetilerArgs(
  osmDir: string,
  outputDir: string,
  image: string,
  pbfName: string,
  javaToolOptions: string,
): string[] {
  return [
    "run",
    "--rm",
    "-e",
    `JAVA_TOOL_OPTIONS=${javaToolOptions}`,
    "-v",
    `${osmDir}:/osm:ro`,
    "-v",
    `${outputDir}:/output`,
    image,
    "--download",
    `--osm-path=/osm/${pbfName}`,
    `--output=/output/${TILE_MBTILES_FILENAME}`,
    "--nodemap-type=array",
    "--force",
  ];
}

export async function buildTileMbtiles(
  opts: BuildTileMbtilesOptions = {},
): Promise<BuildTileMbtilesResult> {
  const paths = repoPaths(opts.rootDir);
  const dataDir = join(paths.infraDir, "data");
  const osmDir = join(dataDir, "osm");
  const outputDir = resolve(dataDir, TILE_MBTILES_DIR);
  const sourcePbf = resolveOsmPbf(dataDir, opts.region, "TileServer MBTiles");
  const image = opts.image ?? DEFAULT_PLANETILER_IMAGE;
  const javaToolOptions = opts.javaToolOptions ?? DEFAULT_PLANETILER_JAVA_TOOL_OPTIONS;
  const runner = opts.runner ?? defaultRunner;

  clearPreviousMbtiles(outputDir);

  await runner(
    "docker",
    dockerPlanetilerArgs(osmDir, outputDir, image, basename(sourcePbf), javaToolOptions),
    { cwd: paths.infraDir, stdio: "inherit" },
  );

  const mbtilesPath = join(outputDir, TILE_MBTILES_FILENAME);
  if (!existsSync(mbtilesPath)) {
    throw new Error(`Tile build finished but did not create ${mbtilesPath}`);
  }

  return {
    sourcePbf,
    outputDir,
    mbtilesPath,
    image,
    javaToolOptions,
  };
}

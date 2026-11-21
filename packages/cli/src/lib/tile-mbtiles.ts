import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { execa } from "execa";
import { withStagedBuildDir } from "./build-staging";
import { cliProcessOptions } from "./execution-deadline";
import { resolveOsmPbf } from "./osm-pbf";
import { repoPaths, resolveInvocationPath } from "./paths";
import { STREET_DETAIL_SCHEMA } from "./street-detail-schema";

export const TILE_MBTILES_DIR = "tile-mbtiles";
export const TILE_MBTILES_FILENAME = "tiles.mbtiles";
export const STREET_DETAIL_MBTILES_FILENAME = "street_detail.mbtiles";
/** `hosted` builds only street detail, for installs that keep a hosted basemap. */
export const TILESERVER_BASEMAP_ENV = "TILESERVER_BASEMAP";
const STREET_DETAIL_SCHEMA_FILENAME = "street-detail.yml";
const STREET_DETAIL_TMP_DIR = "tmp-street-detail";
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
  /** Absolute paths of the archives the build produced. */
  files: string[];
  image: string;
  javaToolOptions: string;
  workDir: string;
}

async function defaultRunner(
  command: string,
  args: string[],
  opts: { cwd?: string; stdio?: "inherit" },
): Promise<void> {
  await execa(command, args, {
    ...cliProcessOptions(),
    cwd: opts.cwd,
    stdio: opts.stdio ?? "inherit",
  });
}

/** The basemap build mode from `TILESERVER_BASEMAP`: unset or `build` builds it, `hosted` skips it. */
export function tileserverBasemapMode(env: NodeJS.ProcessEnv): "build" | "hosted" {
  const value = env[TILESERVER_BASEMAP_ENV]?.trim().toLowerCase() ?? "";
  if (value === "" || value === "build") return "build";
  if (value === "hosted") return "hosted";
  throw new Error(
    `${TILESERVER_BASEMAP_ENV} must be "build" or "hosted", not ${JSON.stringify(env[TILESERVER_BASEMAP_ENV])}.`,
  );
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

/** The second Planetiler run: the `street_detail` custom-map schema, no downloads. */
export function streetDetailDockerArgs(opts: {
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
    "openmapx-build-street-detail",
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
    "generate-custom",
    `--schema=/work/${STREET_DETAIL_SCHEMA_FILENAME}`,
    `--osm-path=/osm/${opts.pbfName}`,
    `--output=/output/${STREET_DETAIL_MBTILES_FILENAME}`,
    `--tmpdir=/work/${STREET_DETAIL_TMP_DIR}`,
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
  const basemap = tileserverBasemapMode(process.env);
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
  rmSync(join(workDir, STREET_DETAIL_TMP_DIR), { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  writeFileSync(join(workDir, STREET_DETAIL_SCHEMA_FILENAME), STREET_DETAIL_SCHEMA);

  const files = [
    ...(basemap === "build" ? [TILE_MBTILES_FILENAME] : []),
    STREET_DETAIL_MBTILES_FILENAME,
  ];
  // Both archives are staged together: a failed run keeps the previous pair,
  // and hosted mode drops an earlier basemap file on promotion.
  await withStagedBuildDir(outputDir, async (nextDir) => {
    const run = {
      osmDir,
      outputDir: nextDir,
      workDir,
      image: opts.image,
      pbfName: basename(sourcePbf),
      javaToolOptions,
      planet: isPlanet(sourcePbf),
    };
    if (basemap === "build")
      await runner("docker", dockerPlanetilerArgs(run), { cwd: paths.infraDir, stdio: "inherit" });
    await runner("docker", streetDetailDockerArgs(run), { cwd: paths.infraDir, stdio: "inherit" });
    for (const file of files) {
      if (!existsSync(join(nextDir, file)))
        throw new Error(`Tile build finished but did not create ${file}`);
    }
  });

  return {
    sourcePbf,
    outputDir,
    files: files.map((file) => join(outputDir, file)),
    image: opts.image,
    javaToolOptions,
    workDir,
  };
}

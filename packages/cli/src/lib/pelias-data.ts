import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { execa } from "execa";
import { resolveOsmPbf } from "./osm-pbf";
import { repoPaths } from "./paths";

export const PELIAS_DATA_DIR = "pelias";
export const PELIAS_OPENSTREETMAP_FILENAME = "data.osm.pbf";
export const PELIAS_PLACEHOLDER_FILENAME = "store.sqlite3";
export const PELIAS_INDEX_NAME = "pelias";
export const PELIAS_BUILD_COMPOSE_FILENAME = ".openmapx-pelias-build.compose.yml";
export const PELIAS_BUILD_PROJECT_NAME = "openmapx-pelias-build";
export const DEFAULT_PELIAS_SCHEMA_IMAGE = "pelias/schema:latest";
export const DEFAULT_PELIAS_WHOSONFIRST_IMAGE = "pelias/whosonfirst:latest";
export const DEFAULT_PELIAS_OPENSTREETMAP_IMAGE = "pelias/openstreetmap:latest";

export type CommandRunner = (
  command: string,
  args: string[],
  opts: { cwd?: string; stdio?: "inherit" },
) => Promise<void>;

export interface BuildPeliasDataOptions {
  rootDir?: string;
  region?: string;
  elasticsearchImage: string;
  placeholderImage: string;
  schemaImage?: string;
  whosonfirstImage?: string;
  openstreetmapImage?: string;
  runner?: CommandRunner;
  elasticsearchReadyAttempts?: number;
  elasticsearchReadyDelayMs?: number;
}

export interface BuildPeliasDataResult {
  sourcePbf: string;
  peliasDir: string;
  openstreetmapPath: string;
  placeholderStorePath: string;
  whosonfirstDir: string;
  elasticsearchImage: string;
  placeholderImage: string;
  schemaImage: string;
  whosonfirstImage: string;
  openstreetmapImage: string;
}

async function defaultRunner(
  command: string,
  args: string[],
  opts: { cwd?: string; stdio?: "inherit" },
): Promise<void> {
  await execa(command, args, { cwd: opts.cwd, stdio: opts.stdio ?? "inherit" });
}

function linkOrCopy(source: string, target: string): void {
  try {
    linkSync(source, target);
  } catch {
    copyFileSync(source, target);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function dockerComposeArgs(composeFile: string, args: string[]): string[] {
  return ["compose", "-p", PELIAS_BUILD_PROJECT_NAME, "-f", composeFile, ...args];
}

function clearPeliasBuildDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

function writeBuildComposeFile(
  composeFile: string,
  images: {
    elasticsearch: string;
    schema: string;
    whosonfirst: string;
    openstreetmap: string;
    placeholder: string;
  },
): void {
  const configMount = "../../services/pelias/config/pelias.json:/code/pelias.json:ro";
  const dataMount = "./data/pelias:/data";
  const dockerUser =
    typeof process.getuid === "function" && typeof process.getgid === "function"
      ? `${process.getuid()}:${process.getgid()}`
      : undefined;

  const serviceBase = {
    environment: { PELIAS_CONFIG: "/code/pelias.json" },
    volumes: [configMount, dataMount],
    networks: ["openmapx"],
    ...(dockerUser ? { user: dockerUser } : {}),
  };

  const compose = {
    services: {
      elasticsearch: {
        image: images.elasticsearch,
        environment: {
          "discovery.type": "single-node",
          ES_JAVA_OPTS: "-Xms2g -Xmx2g",
          "xpack.security.enabled": "false",
        },
        volumes: ["openmapx-esdata:/usr/share/elasticsearch/data"],
        networks: ["openmapx"],
      },
      "pelias-schema": {
        image: images.schema,
        command: ["npm", "run", "create_index"],
        environment: { PELIAS_CONFIG: "/code/pelias.json" },
        volumes: [configMount],
        networks: ["openmapx"],
        ...(dockerUser ? { user: dockerUser } : {}),
      },
      "pelias-whosonfirst-download": {
        image: images.whosonfirst,
        command: ["npm", "run", "download"],
        ...serviceBase,
      },
      "pelias-whosonfirst-import": {
        image: images.whosonfirst,
        command: ["npm", "start"],
        ...serviceBase,
      },
      "pelias-openstreetmap-import": {
        image: images.openstreetmap,
        command: ["npm", "start"],
        ...serviceBase,
      },
      "pelias-placeholder-build": {
        image: images.placeholder,
        command: ["sh", "-lc", "npm run extract && npm run build"],
        ...serviceBase,
      },
    },
    volumes: {
      "openmapx-esdata": null,
    },
    networks: {
      openmapx: {
        driver: "bridge",
      },
    },
  };

  writeFileSync(composeFile, `${JSON.stringify(compose, null, 2)}\n`, "utf-8");
}

async function waitForElasticsearch(
  composeFile: string,
  cwd: string,
  runner: CommandRunner,
  attempts: number,
  delayMs: number,
): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await runner(
        "docker",
        dockerComposeArgs(composeFile, [
          "exec",
          "-T",
          "elasticsearch",
          "curl",
          "-fs",
          "http://localhost:9200/_cluster/health",
        ]),
        { cwd, stdio: "inherit" },
      );
      return;
    } catch (error) {
      if (attempt === attempts) {
        throw new Error(
          `Elasticsearch did not become ready after ${attempts} attempts: ${(error as Error).message}`,
        );
      }
      await sleep(delayMs);
    }
  }
}

function assertDirNotEmpty(dir: string, description: string): void {
  if (!existsSync(dir) || readdirSync(dir).length === 0) {
    throw new Error(`${description} finished but did not populate ${dir}`);
  }
}

async function cleanupPeliasBuildProject(
  composeFile: string,
  cwd: string,
  runner: CommandRunner,
): Promise<void> {
  await runner(
    "docker",
    dockerComposeArgs(composeFile, ["down", "--volumes", "--remove-orphans"]),
    { cwd, stdio: "inherit" },
  );
}

export async function buildPeliasData(
  opts: BuildPeliasDataOptions,
): Promise<BuildPeliasDataResult> {
  const paths = repoPaths(opts.rootDir);
  const dataDir = join(paths.infraDir, "data");
  const peliasDir = resolve(dataDir, PELIAS_DATA_DIR);
  const openstreetmapDir = join(peliasDir, "openstreetmap");
  const whosonfirstDir = join(peliasDir, "whosonfirst");
  const placeholderDir = join(peliasDir, "placeholder");
  const openstreetmapPath = join(openstreetmapDir, PELIAS_OPENSTREETMAP_FILENAME);
  const placeholderStorePath = join(placeholderDir, PELIAS_PLACEHOLDER_FILENAME);
  const sourcePbf = resolveOsmPbf(dataDir, opts.region, "Pelias");
  const schemaImage = opts.schemaImage ?? DEFAULT_PELIAS_SCHEMA_IMAGE;
  const whosonfirstImage = opts.whosonfirstImage ?? DEFAULT_PELIAS_WHOSONFIRST_IMAGE;
  const openstreetmapImage = opts.openstreetmapImage ?? DEFAULT_PELIAS_OPENSTREETMAP_IMAGE;
  const runner = opts.runner ?? defaultRunner;
  const readyAttempts = opts.elasticsearchReadyAttempts ?? 60;
  const readyDelayMs = opts.elasticsearchReadyDelayMs ?? 5000;
  const composeFile = join(paths.infraDir, PELIAS_BUILD_COMPOSE_FILENAME);

  clearPeliasBuildDir(openstreetmapDir);
  clearPeliasBuildDir(whosonfirstDir);
  clearPeliasBuildDir(placeholderDir);
  linkOrCopy(sourcePbf, openstreetmapPath);
  writeBuildComposeFile(composeFile, {
    elasticsearch: opts.elasticsearchImage,
    schema: schemaImage,
    whosonfirst: whosonfirstImage,
    openstreetmap: openstreetmapImage,
    placeholder: opts.placeholderImage,
  });

  let buildError: unknown;
  try {
    await cleanupPeliasBuildProject(composeFile, paths.infraDir, runner);
    await runner("docker", dockerComposeArgs(composeFile, ["up", "-d", "elasticsearch"]), {
      cwd: paths.infraDir,
      stdio: "inherit",
    });
    await waitForElasticsearch(composeFile, paths.infraDir, runner, readyAttempts, readyDelayMs);
    await runner("docker", dockerComposeArgs(composeFile, ["run", "--rm", "pelias-schema"]), {
      cwd: paths.infraDir,
      stdio: "inherit",
    });
    await runner(
      "docker",
      dockerComposeArgs(composeFile, [
        "exec",
        "-T",
        "elasticsearch",
        "curl",
        "-fs",
        `http://localhost:9200/${PELIAS_INDEX_NAME}`,
      ]),
      { cwd: paths.infraDir, stdio: "inherit" },
    );
    await runner(
      "docker",
      dockerComposeArgs(composeFile, ["run", "--rm", "pelias-whosonfirst-download"]),
      { cwd: paths.infraDir, stdio: "inherit" },
    );
    assertDirNotEmpty(whosonfirstDir, "Pelias Who's On First download");
    await runner(
      "docker",
      dockerComposeArgs(composeFile, ["run", "--rm", "pelias-whosonfirst-import"]),
      { cwd: paths.infraDir, stdio: "inherit" },
    );
    await runner(
      "docker",
      dockerComposeArgs(composeFile, ["run", "--rm", "pelias-openstreetmap-import"]),
      { cwd: paths.infraDir, stdio: "inherit" },
    );
    await runner(
      "docker",
      dockerComposeArgs(composeFile, ["run", "--rm", "pelias-placeholder-build"]),
      { cwd: paths.infraDir, stdio: "inherit" },
    );
  } catch (error) {
    buildError = error;
  }

  let cleanupError: unknown;
  try {
    await cleanupPeliasBuildProject(composeFile, paths.infraDir, runner);
  } catch (error) {
    cleanupError = error;
  } finally {
    rmSync(composeFile, { force: true });
  }

  if (buildError) throw buildError;
  if (cleanupError) throw cleanupError;

  if (!existsSync(placeholderStorePath)) {
    throw new Error(`Pelias placeholder build finished but did not create ${placeholderStorePath}`);
  }

  return {
    sourcePbf,
    peliasDir,
    openstreetmapPath,
    placeholderStorePath,
    whosonfirstDir,
    elasticsearchImage: opts.elasticsearchImage,
    placeholderImage: opts.placeholderImage,
    schemaImage,
    whosonfirstImage,
    openstreetmapImage,
  };
}

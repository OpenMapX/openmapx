import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { atomicWrite } from "@openmapx/core/release-files";
import { services as coreServices } from "@openmapx/core/server";
import { execa } from "execa";
import { withStagedBuildDir } from "./build-staging";
import { cliProcessOptions } from "./execution-deadline";
import { resolveOsmPbf } from "./osm-pbf";
import { repoPaths } from "./paths";

export const PELIAS_DATA_DIR = "pelias";
/** Elasticsearch's data dir; the runtime `elasticsearch` service bind-mounts it. */
export const PELIAS_ELASTICSEARCH_DIR = "elasticsearch";
export const PELIAS_OPENSTREETMAP_FILENAME = "data.osm.pbf";
export const PELIAS_PLACEHOLDER_FILENAME = "store.sqlite3";
export const PELIAS_INDEX_NAME = "pelias";
export const PELIAS_BUILD_COMPOSE_FILENAME = "compose.yml";
export const PELIAS_BUILD_PROJECT_NAME = "openmapx-pelias-build";

export type CommandRunner = (
  command: string,
  args: string[],
  opts: { cwd?: string; stdio?: "inherit" | "pipe" },
) => Promise<void>;

export interface BuildPeliasDataOptions {
  rootDir?: string;
  region?: string;
  elasticsearchImage: string;
  placeholderImage: string;
  schemaImage: string;
  whosonfirstImage: string;
  openstreetmapImage: string;
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
  opts: { cwd?: string; stdio?: "inherit" | "pipe" },
): Promise<void> {
  await execa(command, args, {
    ...cliProcessOptions(),
    cwd: opts.cwd,
    stdio: opts.stdio ?? "inherit",
  });
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

function writeBuildComposeFile(
  composeFile: string,
  buildDir: string,
  configPath: string,
  images: {
    elasticsearch: string;
    schema: string;
    whosonfirst: string;
    openstreetmap: string;
    placeholder: string;
  },
): void {
  const configMount = `${configPath}:/code/pelias.json:ro`;
  const dataMount = `${buildDir}:/data`;
  const hasIds = typeof process.getuid === "function" && typeof process.getgid === "function";
  const dockerUser = hasIds ? `${process.getuid?.()}:${process.getgid?.()}` : undefined;
  // Elasticsearch's image is built to run as any uid with gid 0; matching the
  // runtime manifest keeps the index files owned by the data user.
  const elasticsearchUser = hasIds ? `${process.getuid?.()}:0` : undefined;

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
        volumes: [`${join(buildDir, PELIAS_ELASTICSEARCH_DIR)}:/usr/share/elasticsearch/data`],
        networks: ["openmapx"],
        ...(elasticsearchUser ? { user: elasticsearchUser } : {}),
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
    networks: {
      openmapx: {
        driver: "bridge",
      },
    },
  };

  // Its directory is this run's own (see buildPeliasData); the exclusive
  // temporary still refuses anything already there.
  atomicWrite(composeFile, `${JSON.stringify(compose, null, 2)}\n`, 0o600);
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
  await runner("docker", dockerComposeArgs(composeFile, ["down", "--remove-orphans"]), {
    cwd,
    stdio: "inherit",
  });
}

export async function buildPeliasData(
  opts: BuildPeliasDataOptions,
): Promise<BuildPeliasDataResult> {
  const paths = repoPaths(opts.rootDir);
  const dataDir = join(paths.infraDir, "data");
  const peliasDir = resolve(dataDir, PELIAS_DATA_DIR);
  const sourcePbf = resolveOsmPbf(dataDir, opts.region, "Pelias");
  const runner = opts.runner ?? defaultRunner;
  const readyAttempts = opts.elasticsearchReadyAttempts ?? 60;
  const readyDelayMs = opts.elasticsearchReadyDelayMs ?? 5000;
  // The build's Compose project lives in a private directory of its own, not
  // in infra/docker; every path in it is absolute.
  const composeDir = mkdtempSync(join(tmpdir(), "openmapx-pelias-build-"));
  const composeFile = join(composeDir, PELIAS_BUILD_COMPOSE_FILENAME);
  // The release's copy (or the operator's override) the applied generation mounts.
  const configPath = coreServices.appliedServiceFile(
    paths.infraDir,
    "pelias",
    "config/pelias.json",
  );

  // The whole tree, including the Elasticsearch index, is built into a staged
  // dir so a failed import never leaves the runtime stack with a half index.
  try {
    await withStagedBuildDir(peliasDir, (buildDir) =>
      buildPeliasTree({
        buildDir,
        composeFile,
        configPath,
        cwd: paths.infraDir,
        sourcePbf,
        runner,
        readyAttempts,
        readyDelayMs,
        images: {
          elasticsearch: opts.elasticsearchImage,
          schema: opts.schemaImage,
          whosonfirst: opts.whosonfirstImage,
          openstreetmap: opts.openstreetmapImage,
          placeholder: opts.placeholderImage,
        },
      }),
    );
  } finally {
    rmSync(composeDir, { recursive: true, force: true });
  }

  return {
    sourcePbf,
    peliasDir,
    openstreetmapPath: join(peliasDir, "openstreetmap", PELIAS_OPENSTREETMAP_FILENAME),
    placeholderStorePath: join(peliasDir, "placeholder", PELIAS_PLACEHOLDER_FILENAME),
    whosonfirstDir: join(peliasDir, "whosonfirst"),
    elasticsearchImage: opts.elasticsearchImage,
    placeholderImage: opts.placeholderImage,
    schemaImage: opts.schemaImage,
    whosonfirstImage: opts.whosonfirstImage,
    openstreetmapImage: opts.openstreetmapImage,
  };
}

async function buildPeliasTree(opts: {
  buildDir: string;
  composeFile: string;
  configPath: string;
  cwd: string;
  sourcePbf: string;
  runner: CommandRunner;
  readyAttempts: number;
  readyDelayMs: number;
  images: Parameters<typeof writeBuildComposeFile>[3];
}): Promise<void> {
  const { buildDir, composeFile, cwd, runner } = opts;
  const whosonfirstDir = join(buildDir, "whosonfirst");
  for (const sub of ["openstreetmap", "whosonfirst", "placeholder", PELIAS_ELASTICSEARCH_DIR]) {
    mkdirSync(join(buildDir, sub), { recursive: true });
  }
  linkOrCopy(opts.sourcePbf, join(buildDir, "openstreetmap", PELIAS_OPENSTREETMAP_FILENAME));
  writeBuildComposeFile(composeFile, buildDir, opts.configPath, opts.images);

  let buildError: unknown;
  try {
    await cleanupPeliasBuildProject(composeFile, cwd, runner);
    await runner("docker", dockerComposeArgs(composeFile, ["up", "-d", "elasticsearch"]), {
      cwd,
      stdio: "inherit",
    });
    await waitForElasticsearch(composeFile, cwd, runner, opts.readyAttempts, opts.readyDelayMs);
    await runner("docker", dockerComposeArgs(composeFile, ["run", "--rm", "pelias-schema"]), {
      cwd,
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
      { cwd, stdio: "inherit" },
    );
    await runner(
      "docker",
      dockerComposeArgs(composeFile, ["run", "--rm", "pelias-whosonfirst-download"]),
      { cwd, stdio: "inherit" },
    );
    assertDirNotEmpty(whosonfirstDir, "Pelias Who's On First download");
    await runner(
      "docker",
      dockerComposeArgs(composeFile, ["run", "--rm", "pelias-whosonfirst-import"]),
      { cwd, stdio: "inherit" },
    );
    await runner(
      "docker",
      dockerComposeArgs(composeFile, ["run", "--rm", "pelias-openstreetmap-import"]),
      { cwd, stdio: "inherit" },
    );
    await runner(
      "docker",
      dockerComposeArgs(composeFile, ["run", "--rm", "pelias-placeholder-build"]),
      { cwd, stdio: "inherit" },
    );
  } catch (error) {
    buildError = error;
  }

  let cleanupError: unknown;
  try {
    await cleanupPeliasBuildProject(composeFile, cwd, runner);
  } catch (error) {
    cleanupError = error;
  } finally {
    rmSync(composeFile, { force: true });
  }

  if (buildError) throw buildError;
  if (cleanupError) throw cleanupError;

  const placeholderStorePath = join(buildDir, "placeholder", PELIAS_PLACEHOLDER_FILENAME);
  if (!existsSync(placeholderStorePath)) {
    throw new Error(`Pelias placeholder build finished but did not create ${placeholderStorePath}`);
  }
}

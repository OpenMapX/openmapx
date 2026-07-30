import {
  copyFileSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  FEED_PROXY_CONFIG_FILENAME,
  FEED_PROXY_CONFIG_SUBDIR,
  FEED_PROXY_VARS_FILENAME,
  writeFeedProxyVarsFile,
} from "@openmapx/motis-feed-proxy-config";
import {
  type CommandRunner,
  DEFAULT_TRANSITOUS_REPO_URL,
  ensureCatalog,
  findHostedGbfsFeedIds,
  listMirrorArchives,
  mirrorArchives,
  parseTransitSource,
  pruneUnresolvableSources,
  rewriteHostedFeedProxy,
  TRANSITOUS_ARTIFACT_BASE_URL,
  TRANSITOUS_CATALOG_DIR,
  TRANSITOUS_DOWNLOADS_DIR,
  type TransitousLogger,
  type TransitSource,
} from "@openmapx/transitous-core";
import { execa } from "execa";
import { TRANSITOUS_COUNTRIES_ENV } from "./env-defaults";
import { readFeedProxyVars, renderFeedProxyNginxConfig } from "./motis-feed-proxy";
import { resolveOsmPbf } from "./osm-pbf";
import { repoPaths } from "./paths";

// The primary `motis` container bind-mounts data/motis/live (plain bind,
// pipeline-owned). `services build motis` seeds it directly; the data-manager's
// staging→promote pipeline refreshes it via an atomic swap from data/motis/staging.
export const MOTIS_DATA_DIR = "motis/live";
export const MOTIS_FEED_PROXY_DIR = "motis-feed-proxy";
export const MOTIS_FEED_PROXY_CONF_SUBDIR = FEED_PROXY_CONFIG_SUBDIR;
export const MOTIS_CONFIG_FILENAME = "config.yml";
export const MOTIS_LICENSE_FILENAME = "license.json";
export const MOTIS_FEED_PROXY_CONFIG_FILENAME = FEED_PROXY_CONFIG_FILENAME;
export { DEFAULT_TRANSITOUS_REPO_URL };
// CI publishes a multi-arch transitous-tools image (.github/workflows/docker.yml).
// Default to the registry image; ensureTransitousToolsImage falls back to a
// local docker build when the registry pull fails (offline / private fork).
export const DEFAULT_TRANSITOUS_TOOLS_IMAGE =
  process.env.OPENMAPX_TRANSITOUS_TOOLS_IMAGE ?? "ghcr.io/openmapx/transitous-tools:latest";
export const OPENMAPX_TRANSITOUS_FEED_PROXY_URL_ENV = "OPENMAPX_TRANSITOUS_FEED_PROXY_URL";
export const DEFAULT_OPENMAPX_TRANSITOUS_FEED_PROXY_URL = "http://motis-feed-proxy";
export const TRANSITOUS_FEED_PROXY_KEY_FILE_ENV = "TRANSITOUS_FEED_PROXY_KEY_FILE";

const TRANSITOUS_FEED_PROXY_KEY_CONTAINER_PATH = "/run/secrets/transitous-feed-proxy.key";
const EMPTY_FEED_PROXY_KEY_FILENAME = ".empty-feed-proxy.key";

export type { CommandRunner };

export interface BuildMotisDataOptions {
  rootDir?: string;
  region?: string;
  transitousRepoUrl?: string;
  image?: string;
  feedProxyUrl?: string;
  runner?: CommandRunner;
  /** Acquisition mode. Defaults to TRANSIT_SOURCE (mirror). */
  source?: TransitSource;
  /** Mirror-mode artifact base URL. */
  artifactBaseUrl?: string;
}

export interface BuildMotisDataResult {
  sourcePbf: string;
  motisDir: string;
  gtfsFeeds: string[];
  configPath?: string;
  licensePath?: string;
  feedProxyConfigPath?: string;
  feedProxyFeedCount?: number;
  transitousCatalogDir?: string;
  transitousRepoUrl: string;
  image: string;
}

async function defaultRunner(
  command: string,
  args: string[],
  opts: { cwd?: string; stdio?: "inherit" | "pipe" },
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

/**
 * Download `url` to `dest` atomically via the runner's `wget`: stream to a
 * sibling `.tmp` and rename on success. Throws (after cleaning up the temp) on
 * a non-success response or empty body, so the mirror's gtfs→netex spec probe
 * can fall through to the next candidate.
 */
async function downloadArchive(
  runner: CommandRunner,
  url: string,
  dest: string,
  cwd: string,
): Promise<void> {
  const tmp = `${dest}.tmp`;
  try {
    await runner("wget", ["--no-verbose", "-O", tmp, url], { cwd, stdio: "pipe" });
    if (!existsSync(tmp) || statSync(tmp).size === 0) {
      throw new Error(`empty download: ${url}`);
    }
    renameSync(tmp, dest);
  } catch (err) {
    if (existsSync(tmp)) rmSync(tmp, { force: true });
    throw err;
  }
}

function clearPreparedMotisInputs(motisDir: string): void {
  mkdirSync(motisDir, { recursive: true });
  for (const name of readdirSync(motisDir)) {
    if (
      name === "scripts" ||
      name === MOTIS_CONFIG_FILENAME ||
      name === MOTIS_LICENSE_FILENAME ||
      name.endsWith(".pbf") ||
      name.endsWith(".zip")
    ) {
      rmSync(join(motisDir, name), { recursive: true, force: true });
    }
  }
}

function clearPreparedFeedProxyInputs(feedProxyDir: string): void {
  mkdirSync(feedProxyDir, { recursive: true });
  for (const name of readdirSync(feedProxyDir)) {
    rmSync(join(feedProxyDir, name), { recursive: true, force: true });
  }
  mkdirSync(join(feedProxyDir, MOTIS_FEED_PROXY_CONF_SUBDIR), { recursive: true });
}

function stageGtfsFeeds(gtfsDir: string, motisDir: string): string[] {
  if (!existsSync(gtfsDir)) return [];
  const feeds = readdirSync(gtfsDir)
    .filter((name) => name.endsWith(".zip"))
    .map((name) => join(gtfsDir, name))
    .filter((path) => statSync(path).isFile());

  const staged: string[] = [];
  for (const feed of feeds) {
    const target = join(motisDir, basename(feed));
    linkOrCopy(feed, target);
    staged.push(target);
  }
  return staged;
}

/**
 * `docker run` argv for an arbitrary command in the transitous-tools image with
 * the catalog working tree mounted — used to run the resolution pre-check in the
 * container (the CLI has no host Python). Mirrors dockerRunTransitousArgs's
 * mounts but runs `<command> <args>` directly with WORKDIR /transitous.
 */
function dockerExecArgs(
  catalogDir: string,
  gtfsDir: string,
  downloadsDir: string,
  image: string,
  command: string,
  commandArgs: string[],
): string[] {
  const args = [
    "run",
    "--rm",
    "-v",
    `${catalogDir}:/transitous`,
    "-v",
    `${gtfsDir}:/transitous/out`,
    "-v",
    `${downloadsDir}:/transitous/downloads`,
  ];
  if (typeof process.getuid === "function" && typeof process.getgid === "function") {
    args.push("--user", `${process.getuid()}:${process.getgid()}`);
  }
  args.push("-w", "/transitous", image, command, ...commandArgs);
  return args;
}

async function ensureTransitousToolsImage(
  rootDir: string,
  image: string,
  runner: CommandRunner,
): Promise<void> {
  // Try the registry first (fast: skip the multi-stage Python+Go build). Fall
  // back to a local build only when pull fails so private forks / offline
  // hosts still work.
  if (image.includes("/") && !image.endsWith(":local")) {
    try {
      await runner("docker", ["pull", image], { cwd: rootDir, stdio: "inherit" });
      return;
    } catch {
      // fall through to local build
    }
  }
  const contextDir = join(rootDir, "services", "motis", "tools", "transitous");
  await runner("docker", ["build", "-t", image, contextDir], { cwd: rootDir, stdio: "inherit" });
}

function dockerRunTransitousArgs(
  catalogDir: string,
  gtfsDir: string,
  downloadsDir: string,
  runScriptPath: string,
  image: string,
  action: "generate-config" | "generate-attribution" | "generate-feed-proxy-vars",
  options: {
    feedProxyOutDir?: string;
    feedProxyKeyFile?: string;
  } = {},
): string[] {
  const args = [
    "run",
    "--rm",
    "--name",
    `openmapx-build-motis-${action}`,
    "-v",
    `${catalogDir}:/transitous`,
    "-v",
    `${gtfsDir}:/transitous/out`,
    "-v",
    `${downloadsDir}:/transitous/downloads`,
    "-v",
    `${runScriptPath}:/run.sh:ro`,
  ];
  if (options.feedProxyOutDir) {
    args.push("-v", `${options.feedProxyOutDir}:/feed-proxy-out`);
  }
  if (options.feedProxyKeyFile) {
    args.push(
      "-v",
      `${options.feedProxyKeyFile}:${TRANSITOUS_FEED_PROXY_KEY_CONTAINER_PATH}:ro`,
      "-e",
      `${TRANSITOUS_FEED_PROXY_KEY_FILE_ENV}=${TRANSITOUS_FEED_PROXY_KEY_CONTAINER_PATH}`,
    );
  }
  const countries = process.env[TRANSITOUS_COUNTRIES_ENV]?.trim();
  if (countries) {
    args.push("-e", `${TRANSITOUS_COUNTRIES_ENV}=${countries}`);
  }
  if (typeof process.getuid === "function" && typeof process.getgid === "function") {
    args.push("--user", `${process.getuid()}:${process.getgid()}`);
  }
  args.push(image, "/bin/bash", "/run.sh", action);
  return args;
}

function patchMotisConfig(
  configPath: string,
  pbfName: string,
  feedProxyUrl: string,
  feedProxyFeedIds: ReadonlySet<string>,
): void {
  const lines = readFileSync(configPath, "utf-8").split(/\r?\n/);
  const patched: string[] = [];
  let inTilesBlock = false;

  for (const line of lines) {
    if (!inTilesBlock && /^tiles:\s*$/.test(line)) {
      inTilesBlock = true;
      continue;
    }

    if (inTilesBlock) {
      if (/^\s*$/.test(line)) continue;
      if (/^\S/.test(line)) {
        inTilesBlock = false;
      } else {
        continue;
      }
    }

    if (/^osm:\s*/.test(line)) {
      patched.push(`osm: ${pbfName}`);
      continue;
    }

    if (/^\s*num_days:\s*\d+\s*$/.test(line)) {
      patched.push(line.replace(/(\s*num_days:\s*)\d+/, "$190"));
      continue;
    }

    if (/^\s*web_folder:\s*/.test(line)) {
      continue;
    }

    if (/^\s*data_attribution_link:\s*/.test(line)) {
      patched.push("data_attribution_link: /terms#data-sources");
      continue;
    }

    patched.push(line);
  }

  const normalized = `${patched
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()}\n`;
  // Repoint realtime onto our own feed-proxy via the shared helper (same logic
  // the daemon uses), scoped to the feeds our proxy actually serves.
  const { text } = rewriteHostedFeedProxy(normalized, feedProxyUrl, feedProxyFeedIds);
  const missingGbfsFeedIds = findHostedGbfsFeedIds(text);
  if (missingGbfsFeedIds.length > 0) {
    throw new Error(
      `Local feed proxy is missing configured GBFS feeds: ${missingGbfsFeedIds.join(", ")}`,
    );
  }
  writeFileSync(configPath, text, "utf-8");
}

function renderMotisFeedProxyConfig(feedProxyDir: string): {
  configPath: string;
  feedCount: number;
  feedIds: Set<string>;
} {
  const varsPath = join(feedProxyDir, FEED_PROXY_VARS_FILENAME);
  const vars = readFeedProxyVars(varsPath);
  writeFeedProxyVarsFile(varsPath, vars);
  const configText = renderFeedProxyNginxConfig(vars);
  const confDir = join(feedProxyDir, MOTIS_FEED_PROXY_CONF_SUBDIR);
  mkdirSync(confDir, { recursive: true });
  const configPath = join(confDir, MOTIS_FEED_PROXY_CONFIG_FILENAME);
  writeFileSync(configPath, configText, "utf-8");
  const feedIds = new Set(Object.keys(vars));
  return { configPath, feedCount: feedIds.size, feedIds };
}

function ensureFeedProxyKeyFile(feedProxyDir: string): string {
  const configured = process.env[TRANSITOUS_FEED_PROXY_KEY_FILE_ENV]?.trim();
  if (configured) {
    const resolved = resolve(configured);
    if (!existsSync(resolved)) {
      throw new Error(
        `${TRANSITOUS_FEED_PROXY_KEY_FILE_ENV} is set but the file does not exist: ${resolved}`,
      );
    }
    return resolved;
  }

  const emptyKeyFile = join(feedProxyDir, EMPTY_FEED_PROXY_KEY_FILENAME);
  writeFileSync(emptyKeyFile, "\n", "utf-8");
  return emptyKeyFile;
}

function copyGeneratedMotisArtifacts(
  gtfsDir: string,
  motisDir: string,
  pbfName: string,
  feedProxyUrl: string,
  feedProxyFeedIds: ReadonlySet<string>,
): {
  configPath: string;
  licensePath: string;
} {
  const generatedConfigPath = join(gtfsDir, MOTIS_CONFIG_FILENAME);
  if (!existsSync(generatedConfigPath)) {
    throw new Error(
      `Transitous config generation finished but did not create ${generatedConfigPath}`,
    );
  }
  const configPath = join(motisDir, MOTIS_CONFIG_FILENAME);
  copyFileSync(generatedConfigPath, configPath);
  patchMotisConfig(configPath, pbfName, feedProxyUrl, feedProxyFeedIds);

  const generatedLicensePath = join(gtfsDir, MOTIS_LICENSE_FILENAME);
  if (!existsSync(generatedLicensePath)) {
    throw new Error(
      `Transitous attribution generation finished but did not create ${generatedLicensePath}`,
    );
  }
  const licensePath = join(motisDir, MOTIS_LICENSE_FILENAME);
  copyFileSync(generatedLicensePath, licensePath);

  const scriptsDir = join(gtfsDir, "scripts");
  if (existsSync(scriptsDir)) {
    cpSync(scriptsDir, join(motisDir, "scripts"), { recursive: true });
  }

  return { configPath, licensePath };
}

export async function buildMotisData(
  opts: BuildMotisDataOptions = {},
): Promise<BuildMotisDataResult> {
  const paths = repoPaths(opts.rootDir);
  const dataDir = join(paths.infraDir, "data");
  const gtfsDir = join(dataDir, "gtfs");
  const motisDir = resolve(dataDir, MOTIS_DATA_DIR);
  const feedProxyDir = resolve(dataDir, MOTIS_FEED_PROXY_DIR);
  const sourcePbf = resolveOsmPbf(dataDir, opts.region, "MOTIS");
  const runner = opts.runner ?? defaultRunner;
  const transitousRepoUrl = opts.transitousRepoUrl ?? DEFAULT_TRANSITOUS_REPO_URL;
  const image = opts.image ?? DEFAULT_TRANSITOUS_TOOLS_IMAGE;
  const source = opts.source ?? parseTransitSource();
  // `||` (not `??`): an empty-string env value (e.g. compose `${VAR:-}`) must
  // fall through to the default rather than being taken literally.
  const artifactBaseUrl =
    opts.artifactBaseUrl ||
    process.env.TRANSITOUS_ARTIFACT_BASE_URL ||
    TRANSITOUS_ARTIFACT_BASE_URL;
  const feedProxyUrl =
    opts.feedProxyUrl ||
    process.env[OPENMAPX_TRANSITOUS_FEED_PROXY_URL_ENV] ||
    DEFAULT_OPENMAPX_TRANSITOUS_FEED_PROXY_URL;
  const countries = (process.env[TRANSITOUS_COUNTRIES_ENV] ?? "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  const cliLogger: TransitousLogger = {
    info: (m) => console.error(m),
    warn: (m) => console.error(m),
    error: (m) => console.error(m),
  };

  clearPreparedMotisInputs(motisDir);
  clearPreparedFeedProxyInputs(feedProxyDir);
  linkOrCopy(sourcePbf, join(motisDir, basename(sourcePbf)));

  const catalogDir = resolve(dataDir, TRANSITOUS_CATALOG_DIR);

  // Mirror mode: clone the catalog up front (it tells us which archives to
  // download), then fetch each feed source's already-cleaned archive directly by
  // URL (`<region>_<name>.<spec>.zip`), skipping fetch.py + gtfsclean. The config
  // + attribution are still generated from the catalog below, so the osm/tiles/RT
  // rewrites apply identically to build mode.
  let transitousCatalogDir: string | undefined;
  if (source === "mirror") {
    transitousCatalogDir = await ensureCatalog({
      dataDir,
      catalogDir,
      repoUrl: transitousRepoUrl,
      runner,
      stdio: "inherit",
    });
    mkdirSync(gtfsDir, { recursive: true });
    const archives = listMirrorArchives(transitousCatalogDir, countries);
    const { fetched, missing } = await mirrorArchives({
      archives,
      baseUrl: artifactBaseUrl,
      destDir: gtfsDir,
      download: (url, dest) => downloadArchive(runner, url, dest, paths.root),
      logger: cliLogger,
    });
    cliLogger.info(
      `transitous-mirror: fetched ${fetched}/${archives.length} archive(s)` +
        (missing.length ? `; ${missing.length} missing` : ""),
    );
  }

  const gtfsFeeds = stageGtfsFeeds(gtfsDir, motisDir);
  const { configPath: emptyFeedProxyConfigPath, feedCount: emptyFeedProxyFeedCount } =
    renderMotisFeedProxyConfig(feedProxyDir);

  if (gtfsFeeds.length === 0) {
    return {
      sourcePbf,
      motisDir,
      gtfsFeeds,
      feedProxyConfigPath: emptyFeedProxyConfigPath,
      feedProxyFeedCount: emptyFeedProxyFeedCount,
      transitousCatalogDir,
      transitousRepoUrl,
      image,
    };
  }

  // Build mode hasn't needed the catalog until now (with 0 feeds it returns
  // above without cloning); ensure it here — a no-op reuse if mirror mode above
  // already cloned it.
  transitousCatalogDir ??= await ensureCatalog({
    dataDir,
    catalogDir,
    repoUrl: transitousRepoUrl,
    runner,
    stdio: "inherit",
  });
  const transitousDownloadsDir = resolve(dataDir, TRANSITOUS_DOWNLOADS_DIR);
  const feedProxyKeyFile = ensureFeedProxyKeyFile(feedProxyDir);
  mkdirSync(transitousDownloadsDir, { recursive: true });
  await ensureTransitousToolsImage(paths.root, image, runner);

  // Pre-skip sources upstream can't resolve by RUNNING its resolver in the
  // tools container and acting on the "Could not resolve" verdict (same as the
  // daemon — delegates to upstream, so it handles credential-gated feeds the
  // old static atlas-presence check missed). Otherwise generate-config exits on
  // the first such source and kills the build.
  await pruneUnresolvableSources({
    catalogDir: transitousCatalogDir,
    countries,
    runner: async (command, commandArgs) =>
      runner(
        "docker",
        dockerExecArgs(
          transitousCatalogDir,
          gtfsDir,
          transitousDownloadsDir,
          image,
          command,
          commandArgs,
        ),
        { cwd: paths.root, stdio: "pipe" },
      ),
    logger: cliLogger,
  });

  const runScriptPath = join(paths.root, "services", "motis", "tools", "transitous", "run.sh");
  // The MOTIS config + attribution are generated from the catalog in BOTH modes
  // (so the osm override, tiles strip, and rt→our-proxy rewrite all apply). The
  // only difference: build mode stages GTFS that `data download gtfs` fetched,
  // mirror mode downloaded Transitous's already-cleaned archives above.
  await runner(
    "docker",
    dockerRunTransitousArgs(
      transitousCatalogDir,
      gtfsDir,
      transitousDownloadsDir,
      runScriptPath,
      image,
      "generate-config",
      { feedProxyKeyFile },
    ),
    { cwd: paths.root, stdio: "inherit" },
  );
  await runner(
    "docker",
    dockerRunTransitousArgs(
      transitousCatalogDir,
      gtfsDir,
      transitousDownloadsDir,
      runScriptPath,
      image,
      "generate-attribution",
      { feedProxyKeyFile },
    ),
    { cwd: paths.root, stdio: "inherit" },
  );
  await runner(
    "docker",
    dockerRunTransitousArgs(
      transitousCatalogDir,
      gtfsDir,
      transitousDownloadsDir,
      runScriptPath,
      image,
      "generate-feed-proxy-vars",
      {
        feedProxyOutDir: feedProxyDir,
        feedProxyKeyFile,
      },
    ),
    { cwd: paths.root, stdio: "inherit" },
  );

  const {
    configPath: feedProxyConfigPath,
    feedCount: feedProxyFeedCount,
    feedIds: feedProxyFeedIds,
  } = renderMotisFeedProxyConfig(feedProxyDir);
  const { configPath, licensePath } = copyGeneratedMotisArtifacts(
    gtfsDir,
    motisDir,
    basename(sourcePbf),
    feedProxyUrl,
    feedProxyFeedIds,
  );

  return {
    sourcePbf,
    motisDir,
    gtfsFeeds,
    configPath,
    licensePath,
    feedProxyConfigPath,
    feedProxyFeedCount,
    transitousCatalogDir,
    transitousRepoUrl,
    image,
  };
}

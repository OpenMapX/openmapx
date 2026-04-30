import {
  copyFileSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { execa } from "execa";
import { TRANSITOUS_COUNTRIES_ENV } from "./env-defaults";
import { readFeedProxyVars, renderFeedProxyNginxConfig } from "./motis-feed-proxy";
import { resolveOsmPbf } from "./osm-pbf";
import { repoPaths } from "./paths";

export const MOTIS_DATA_DIR = "motis-data";
export const MOTIS_FEED_PROXY_DIR = "motis-feed-proxy";
export const MOTIS_FEED_PROXY_CONF_SUBDIR = "conf";
export const MOTIS_CONFIG_FILENAME = "config.yml";
export const MOTIS_LICENSE_FILENAME = "license.json";
export const MOTIS_FEED_PROXY_CONFIG_FILENAME = "default.conf";
export const DEFAULT_TRANSITOUS_REPO_URL = "https://github.com/public-transport/transitous.git";
// CI publishes a multi-arch transitous-tools image (.github/workflows/docker.yml).
// Default to the registry image; ensureTransitousToolsImage falls back to a
// local docker build when the registry pull fails (offline / private fork).
export const DEFAULT_TRANSITOUS_TOOLS_IMAGE =
  process.env.OPENMAPX_TRANSITOUS_TOOLS_IMAGE ??
  "ghcr.io/medformatik/openmapx-transitous-tools:latest";
export const OPENMAPX_TRANSITOUS_FEED_PROXY_URL_ENV = "OPENMAPX_TRANSITOUS_FEED_PROXY_URL";
export const DEFAULT_OPENMAPX_TRANSITOUS_FEED_PROXY_URL = "http://motis-feed-proxy";
export const TRANSITOUS_FEED_PROXY_KEY_FILE_ENV = "TRANSITOUS_FEED_PROXY_KEY_FILE";

const TRANSITOUS_CATALOG_DIR = ".transitous-catalog";
const TRANSITOUS_DOWNLOADS_DIR = ".transitous-downloads";
const FEED_PROXY_VARS_FILENAME = "feed-proxy-vars.json";
const TRANSITOUS_FEED_PROXY_KEY_CONTAINER_PATH = "/run/secrets/transitous-feed-proxy.key";
const EMPTY_FEED_PROXY_KEY_FILENAME = ".empty-feed-proxy.key";

export type CommandRunner = (
  command: string,
  args: string[],
  opts: { cwd?: string; stdio?: "inherit" },
) => Promise<void>;

export interface BuildMotisDataOptions {
  rootDir?: string;
  region?: string;
  transitousRepoUrl?: string;
  image?: string;
  feedProxyUrl?: string;
  runner?: CommandRunner;
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

function clearPreparedMotisInputs(motisDir: string): void {
  mkdirSync(motisDir, { recursive: true });
  for (const name of readdirSync(motisDir)) {
    if (name === "openmapx-feeds.json") continue;
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

async function ensureTransitousCatalog(
  dataDir: string,
  repoUrl: string,
  runner: CommandRunner,
): Promise<string> {
  const catalogDir = resolve(dataDir, TRANSITOUS_CATALOG_DIR);
  if (existsSync(join(catalogDir, ".git"))) {
    await runner("git", ["-C", catalogDir, "pull", "--ff-only"], {
      cwd: dataDir,
      stdio: "inherit",
    });
    await runner(
      "git",
      ["-C", catalogDir, "submodule", "update", "--init", "--checkout", "--depth", "1"],
      {
        cwd: dataDir,
        stdio: "inherit",
      },
    );
    return catalogDir;
  }

  rmSync(catalogDir, { recursive: true, force: true });
  await runner(
    "git",
    ["clone", "--depth", "1", "--recurse-submodules", "--shallow-submodules", repoUrl, catalogDir],
    {
      cwd: dataDir,
      stdio: "inherit",
    },
  );
  return catalogDir;
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

  const normalizedFeedProxyUrl = feedProxyUrl.trim().replace(/\/+$/, "");
  const text = `${patched
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()}\n`.replace(/https:\/\/rt\.triptix\.tech\/feed\/([^\s"']+)/g, (match, rawFeedId) => {
    const decodedFeedId = (() => {
      try {
        return decodeURIComponent(rawFeedId);
      } catch {
        return rawFeedId;
      }
    })();
    if (!feedProxyFeedIds.has(decodedFeedId) && !feedProxyFeedIds.has(rawFeedId)) {
      return match;
    }
    return `${normalizedFeedProxyUrl}/feed/${rawFeedId}`;
  });
  writeFileSync(configPath, text, "utf-8");
}

function renderMotisFeedProxyConfig(feedProxyDir: string): {
  configPath: string;
  feedCount: number;
  feedIds: Set<string>;
} {
  const varsPath = join(feedProxyDir, FEED_PROXY_VARS_FILENAME);
  const vars = readFeedProxyVars(varsPath);
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
  const feedProxyUrl =
    opts.feedProxyUrl ??
    process.env[OPENMAPX_TRANSITOUS_FEED_PROXY_URL_ENV] ??
    DEFAULT_OPENMAPX_TRANSITOUS_FEED_PROXY_URL;

  clearPreparedMotisInputs(motisDir);
  clearPreparedFeedProxyInputs(feedProxyDir);
  linkOrCopy(sourcePbf, join(motisDir, basename(sourcePbf)));
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
      transitousRepoUrl,
      image,
    };
  }

  const transitousCatalogDir = await ensureTransitousCatalog(dataDir, transitousRepoUrl, runner);
  const transitousDownloadsDir = resolve(dataDir, TRANSITOUS_DOWNLOADS_DIR);
  const feedProxyKeyFile = ensureFeedProxyKeyFile(feedProxyDir);
  mkdirSync(transitousDownloadsDir, { recursive: true });
  await ensureTransitousToolsImage(paths.root, image, runner);

  const runScriptPath = join(paths.root, "services", "motis", "tools", "transitous", "run.sh");
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

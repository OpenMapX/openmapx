import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execa } from "execa";
import { DEFAULT_TRANSITOUS_REPO_URL as DEFAULT_TRANSITOUS_REPO_URL_VALUE } from "./motis-data";
import { repoPaths } from "./paths";

const TRANSITOUS_CATALOG_DIR = ".transitous-catalog";
export const DEFAULT_TRANSITOUS_REPO_URL = DEFAULT_TRANSITOUS_REPO_URL_VALUE;

interface TransitousAtlasFeed {
  id?: string;
  authorization?: unknown;
}

interface TransitousAtlasFile {
  feeds?: TransitousAtlasFeed[];
}

interface TransitousFeedSource {
  name?: string;
  "api-key"?: string;
  "url-override"?: string;
  "transitland-atlas-id"?: string;
}

interface TransitousFeedFile {
  sources?: TransitousFeedSource[];
}

export type CommandRunner = (
  command: string,
  args: string[],
  opts: { cwd?: string; stdio?: "inherit" | "pipe" },
) => Promise<void>;

export interface GenerateTransitousApiKeysOptions {
  rootDir?: string;
  transitousRepoUrl?: string;
  outputPath?: string;
  runner?: CommandRunner;
}

export interface GenerateTransitousApiKeysResult {
  outputPath: string;
  catalogDir: string;
  requiredCount: number;
  preservedCount: number;
  droppedCount: number;
}

async function defaultRunner(
  command: string,
  args: string[],
  opts: { cwd?: string; stdio?: "inherit" | "pipe" },
): Promise<void> {
  await execa(command, args, { cwd: opts.cwd, stdio: opts.stdio ?? "pipe" });
}

async function resetTransitousCatalog(catalogDir: string, runner: CommandRunner): Promise<void> {
  try {
    await runner("git", ["-C", catalogDir, "reset", "--hard", "HEAD"], {
      cwd: catalogDir,
      stdio: "pipe",
    });
  } catch {
    // Best effort only. If this fails we still try to continue with the local clone.
  }
}

async function ensureTransitousCatalog(
  dataDir: string,
  repoUrl: string,
  runner: CommandRunner,
): Promise<string> {
  mkdirSync(dataDir, { recursive: true });
  const catalogDir = resolve(dataDir, TRANSITOUS_CATALOG_DIR);
  if (existsSync(join(catalogDir, ".git"))) {
    await resetTransitousCatalog(catalogDir, runner);
    try {
      await runner("git", ["-C", catalogDir, "pull", "--ff-only"], {
        cwd: dataDir,
        stdio: "pipe",
      });
    } catch {
      // Keep using the cached checkout if the upstream refresh fails.
    }
    await runner(
      "git",
      ["-C", catalogDir, "submodule", "update", "--init", "--checkout", "--depth", "1"],
      {
        cwd: dataDir,
        stdio: "pipe",
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
      stdio: "pipe",
    },
  );
  return catalogDir;
}

function listFilesRecursively(dir: string, suffix: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  const stack = [dir];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
      } else if (entry.isFile() && entry.name.endsWith(suffix)) {
        files.push(path);
      }
    }
  }

  return files.sort((a, b) => a.localeCompare(b));
}

function collectAtlasAuthorisedFeedIds(catalogDir: string): Set<string> {
  const atlasFeedsDir = join(catalogDir, "transitland-atlas", "feeds");
  if (!existsSync(atlasFeedsDir)) {
    throw new Error(
      `Transitous catalog missing transitland-atlas feed directory: ${atlasFeedsDir}`,
    );
  }

  const authorisedFeedIds = new Set<string>();
  const dmfrFiles = listFilesRecursively(atlasFeedsDir, ".dmfr.json");
  for (const filePath of dmfrFiles) {
    let payload: TransitousAtlasFile;
    try {
      payload = JSON.parse(readFileSync(filePath, "utf-8")) as TransitousAtlasFile;
    } catch {
      continue;
    }
    for (const feed of payload.feeds ?? []) {
      if (typeof feed.id !== "string" || feed.id.length === 0) continue;
      if (feed.authorization === undefined || feed.authorization === null) continue;
      authorisedFeedIds.add(feed.id);
    }
  }
  return authorisedFeedIds;
}

function collectRequiredApiKeys(catalogDir: string, authorisedFeedIds: Set<string>): string[] {
  const feedsDir = join(catalogDir, "feeds");
  if (!existsSync(feedsDir)) {
    throw new Error(`Transitous catalog missing feed directory: ${feedsDir}`);
  }

  const keys = new Set<string>();
  const feedFiles = readdirSync(feedsDir)
    .filter((name) => name.endsWith(".json"))
    .sort((a, b) => a.localeCompare(b));

  for (const fileName of feedFiles) {
    const region = fileName.replace(/\.json$/i, "");
    let feedFile: TransitousFeedFile;
    try {
      feedFile = JSON.parse(readFileSync(join(feedsDir, fileName), "utf-8")) as TransitousFeedFile;
    } catch {
      continue;
    }

    for (const source of feedFile.sources ?? []) {
      const atlasId = source["transitland-atlas-id"];
      if (typeof atlasId !== "string" || atlasId.length === 0) continue;
      if (!authorisedFeedIds.has(atlasId)) continue;
      if (typeof source["api-key"] === "string" && source["api-key"].trim().length > 0) continue;
      if (typeof source["url-override"] === "string" && source["url-override"].trim().length > 0)
        continue;
      if (typeof source.name !== "string" || source.name.trim().length === 0) continue;
      keys.add(`${region}/${source.name}`);
    }
  }

  return [...keys].sort((a, b) => a.localeCompare(b));
}

function readExistingApiKeys(outputPath: string): Record<string, string> {
  if (!existsSync(outputPath)) return {};
  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(outputPath, "utf-8"));
  } catch (error) {
    throw new Error(
      `Failed to parse existing api-keys file at ${outputPath}: ${(error as Error).message}`,
    );
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`Expected api-keys file to contain a JSON object: ${outputPath}`);
  }

  const existing: Record<string, string> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key.startsWith("_")) continue;
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    existing[key] = trimmed;
  }
  return existing;
}

export async function generateTransitousApiKeys(
  opts: GenerateTransitousApiKeysOptions = {},
): Promise<GenerateTransitousApiKeysResult> {
  const runner = opts.runner ?? defaultRunner;
  const paths = repoPaths(opts.rootDir);
  const dataDir = join(paths.infraDir, "data");
  const outputPath = opts.outputPath
    ? resolve(paths.root, opts.outputPath)
    : join(paths.root, "services", "motis", "tools", "transitous", "api-keys.json");

  const catalogDir = await ensureTransitousCatalog(
    dataDir,
    opts.transitousRepoUrl ?? DEFAULT_TRANSITOUS_REPO_URL,
    runner,
  );

  const existing = readExistingApiKeys(outputPath);
  const requiredKeys = collectRequiredApiKeys(
    catalogDir,
    collectAtlasAuthorisedFeedIds(catalogDir),
  );
  const requiredSet = new Set(requiredKeys);
  const droppedCount = Object.keys(existing).filter((key) => !requiredSet.has(key)).length;

  const rendered: Record<string, string> = {};
  let preservedCount = 0;
  for (const key of requiredKeys) {
    const preserved = existing[key];
    if (preserved) {
      rendered[key] = preserved;
      preservedCount++;
      continue;
    }
    rendered[key] = "";
  }

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(rendered, null, 2)}\n`, "utf-8");

  return {
    outputPath,
    catalogDir,
    requiredCount: requiredKeys.length,
    preservedCount,
    droppedCount,
  };
}

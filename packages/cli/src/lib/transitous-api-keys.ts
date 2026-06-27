import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  type CommandRunner,
  DEFAULT_TRANSITOUS_REPO_URL,
  ensureCatalog,
  TRANSITOUS_CATALOG_DIR,
  type TransitousFeedFile,
} from "@openmapx/transitous-core";
import { execa } from "execa";
import { repoPaths } from "./paths";

export type { CommandRunner };
export { DEFAULT_TRANSITOUS_REPO_URL };

interface TransitousAtlasFeed {
  id?: string;
  authorization?: unknown;
}

interface TransitousAtlasFile {
  feeds?: TransitousAtlasFeed[];
}

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

/** Defense-in-depth: refuse to write outside the monorepo root. */
function assertInsideRoot(candidate: string, root: string): string {
  const rel = relative(root, candidate);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`--output must resolve to a path inside ${root} (got ${candidate})`);
  }
  return candidate;
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
    ? assertInsideRoot(resolve(paths.root, opts.outputPath), paths.root)
    : join(paths.root, "services", "motis", "tools", "transitous", "api-keys.json");

  mkdirSync(dataDir, { recursive: true });
  const catalogDir = await ensureCatalog({
    dataDir,
    catalogDir: resolve(dataDir, TRANSITOUS_CATALOG_DIR),
    repoUrl: opts.transitousRepoUrl ?? DEFAULT_TRANSITOUS_REPO_URL,
    runner,
    reset: true,
  });

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

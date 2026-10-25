import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { atomicWrite, fsyncDirectory } from "@openmapx/core/release-files";
import {
  type CommandRunner,
  DEFAULT_TRANSITOUS_REPO_URL,
  ensureCatalog,
  TRANSITOUS_CATALOG_DIR,
  type TransitousFeedFile,
} from "@openmapx/transitous-core";
import { execa } from "execa";
import { repoPaths } from "./paths";
import { ensurePlatformPrivateDirectory } from "./platform-secret-files";

export type { CommandRunner };
export { DEFAULT_TRANSITOUS_REPO_URL };

/**
 * The operator's Transitous API keys live alone in their own directory under
 * the secrets directory, which data-manager mounts read-only at
 * `/config/transitous`. A directory, not the file: data-manager reads the keys
 * at every run, and a file mount would keep showing the file a rename
 * replaced until the container is recreated.
 */
export const TRANSITOUS_API_KEYS_DIRECTORY = "transitous-api-keys";
export const TRANSITOUS_API_KEYS_FILENAME = "api-keys.json";
const TRANSITOUS_API_KEYS_MODE = 0o600;
const MAX_TRANSITOUS_API_KEYS_BYTES = 1024 * 1024;

export function transitousApiKeysPath(infraDir: string): string {
  return join(infraDir, "secrets", TRANSITOUS_API_KEYS_DIRECTORY, TRANSITOUS_API_KEYS_FILENAME);
}

/** Where releases before this one kept the keys, in the checkout. */
export function legacyTransitousApiKeysPath(rootDir: string): string {
  return join(rootDir, "services", "motis", "tools", "transitous", TRANSITOUS_API_KEYS_FILENAME);
}

export interface EnsureTransitousApiKeysResult {
  path: string;
  /** What this call created: the earlier file's copy, an empty file, or nothing. */
  created: "copied" | "empty" | null;
  /** Why an earlier file was left in place, when one was. */
  leftInPlace?: { path: string; reason: string };
}

function isApiKeysDocument(text: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  return (
    parsed !== null &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    Object.values(parsed).every((value) => typeof value === "string")
  );
}

/**
 * The file's text, read without following a link, or why it can't be used.
 * `writableByOthers` decides whether group or other write refuses it; when it
 * doesn't, the file is made owner-only instead.
 */
function readOwnedApiKeysFile(
  path: string,
  uid: number,
  writableByOthers: "refuse" | "restrict",
): { text: string } | { reason: string } {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      return { reason: "it is a symbolic link" };
    }
    throw error;
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) return { reason: "it is not a regular file" };
    if (stats.uid !== uid) return { reason: `it belongs to uid ${stats.uid}, not ${uid}` };
    if (stats.nlink !== 1) return { reason: `it has ${stats.nlink} links` };
    if ((stats.mode & 0o022) !== 0 && writableByOthers === "refuse") {
      return { reason: "group or others can write it" };
    }
    if (stats.size > MAX_TRANSITOUS_API_KEYS_BYTES) return { reason: "it is larger than 1 MiB" };
    const bytes = Buffer.alloc(stats.size);
    const read = stats.size === 0 ? 0 : readSync(fd, bytes, 0, stats.size, 0);
    const text = bytes.subarray(0, read).toString("utf8");
    if (!isApiKeysDocument(text)) return { reason: "it is not a JSON object of key strings" };
    if (writableByOthers === "restrict") fchmodSync(fd, TRANSITOUS_API_KEYS_MODE);
    return { text };
  } finally {
    closeSync(fd);
  }
}

/** Creates the file without replacing one that appeared meanwhile. */
function publishApiKeysFile(path: string, contents: string): void {
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  const fd = openSync(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    TRANSITOUS_API_KEYS_MODE,
  );
  try {
    writeFileSync(fd, contents, "utf8");
    fchmodSync(fd, TRANSITOUS_API_KEYS_MODE);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(temporary, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    unlinkSync(temporary);
  }
  fsyncDirectory(dirname(path));
}

/**
 * Makes sure the keys file exists in its directory before a generation mounts
 * it. The first time, the earlier release's file in the checkout is copied,
 * not moved, so that release still finds it after a rollback; only a regular
 * file of the deployment's user with one link that neither group nor others
 * can write, holding a JSON object of key strings, is copied. Anything else
 * stays where it is, the result says why, and the keys file starts empty.
 * An existing keys file must meet the same rules and is kept owner-only.
 */
export function ensureTransitousApiKeysFile(rootDir?: string): EnsureTransitousApiKeysResult {
  const paths = repoPaths(rootDir);
  const uid = process.geteuid?.();
  if (uid === undefined) throw new Error("Transitous API keys ownership is unavailable");
  const path = transitousApiKeysPath(paths.infraDir);
  // The secrets directory itself is protected by the platform secrets render
  // creates first; this one holds nothing but the keys.
  ensurePlatformPrivateDirectory(dirname(path));

  if (lstatExists(path)) {
    // Like the other secrets: kept owner-only, refused when it isn't its own.
    const current = readOwnedApiKeysFile(path, uid, "restrict");
    if ("reason" in current) {
      throw new Error(`Transitous API keys at ${path} can't be used: ${current.reason}`);
    }
    return { path, created: null };
  }

  const legacy = legacyTransitousApiKeysPath(paths.root);
  if (lstatExists(legacy)) {
    const earlier = readOwnedApiKeysFile(legacy, uid, "refuse");
    if ("reason" in earlier) {
      publishApiKeysFile(path, "{}\n");
      return { path, created: "empty", leftInPlace: { path: legacy, reason: earlier.reason } };
    }
    publishApiKeysFile(path, earlier.text);
    return { path, created: "copied" };
  }
  publishApiKeysFile(path, "{}\n");
  return { path, created: "empty" };
}

function lstatExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * The names of the keys a file sets, read without following a link; values are
 * looked at only to tell a set key from an empty slot and never leave here.
 */
function setKeyNames(path: string): { names: Set<string> } | { reason: string } {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP") return { reason: "it is a symbolic link" };
    if (code === "EACCES") return { reason: "it can't be read" };
    throw error;
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) return { reason: "it is not a regular file" };
    if (stats.size > MAX_TRANSITOUS_API_KEYS_BYTES) return { reason: "it is larger than 1 MiB" };
    const bytes = Buffer.alloc(stats.size);
    const read = stats.size === 0 ? 0 : readSync(fd, bytes, 0, stats.size, 0);
    const text = bytes.subarray(0, read).toString("utf8");
    if (!isApiKeysDocument(text)) return { reason: "it is not a JSON object of key strings" };
    const entries = Object.entries(JSON.parse(text) as Record<string, string>);
    return {
      names: new Set(
        entries
          .filter(([name, value]) => !name.startsWith("_") && value.trim().length > 0)
          .map(([name]) => name),
      ),
    };
  } finally {
    closeSync(fd);
  }
}

/**
 * While the earlier release's keys file in the checkout still sets keys the
 * keys file doesn't, a line saying so, why it was not copied and how to carry
 * them over; `null` otherwise. Only key names appear, never values. `check`
 * reports it on every run, since the render's notice is printed once.
 */
export function transitousApiKeysLeftBehindWarning(rootDir?: string): string | null {
  const paths = repoPaths(rootDir);
  const legacy = legacyTransitousApiKeysPath(paths.root);
  const current = transitousApiKeysPath(paths.infraDir);
  // Before the first render there is nothing to compare; it copies the file.
  if (!lstatExists(legacy) || !lstatExists(current)) return null;
  const uid = process.geteuid?.();
  if (uid === undefined) return null;
  const shownLegacy = relative(paths.root, legacy);
  const shownCurrent = relative(paths.root, current);
  const fix = `Copy the keys you meant to keep into ${shownCurrent}, or run pnpm openmapx data generate-api-keys and enter them again.`;

  const earlier = setKeyNames(legacy);
  if ("reason" in earlier) {
    return `The earlier Transitous API keys file ${shownLegacy} was left in place and can't be compared with ${shownCurrent}: ${earlier.reason}. ${fix}`;
  }
  const now = setKeyNames(current);
  const set = "names" in now ? now.names : new Set<string>();
  const missing = [...earlier.names].filter((name) => !set.has(name)).sort();
  if (missing.length === 0) return null;
  const refusal = readOwnedApiKeysFile(legacy, uid, "refuse");
  const why =
    "reason" in refusal
      ? `it was not copied because ${refusal.reason}`
      : `${shownCurrent} already existed, so it is no longer copied`;
  const shown = missing.slice(0, 10).join(", ");
  const more = missing.length > 10 ? ` and ${missing.length - 10} more` : "";
  return `The earlier Transitous API keys file ${shownLegacy} sets ${missing.length} key${missing.length === 1 ? "" : "s"} that ${shownCurrent} doesn't (${shown}${more}): ${why}. ${fix}`;
}

/** One line for the render's output about what {@link ensureTransitousApiKeysFile} did. */
export function describeTransitousApiKeysMigration(
  result: EnsureTransitousApiKeysResult,
  rootDir: string,
): { level: "info" | "warn"; message: string } | null {
  const shown = (path: string) => relative(rootDir, path);
  if (result.created === "copied") {
    return {
      level: "info",
      message: `Copied the Transitous API keys from ${shown(legacyTransitousApiKeysPath(rootDir))} to ${shown(result.path)}; the earlier file stays for rolling back and is no longer read.`,
    };
  }
  if (result.leftInPlace) {
    return {
      level: "warn",
      message: `Left the earlier Transitous API keys file ${shown(result.leftInPlace.path)} in place and started an empty ${shown(result.path)}: ${result.leftInPlace.reason}. If it is yours, check it and copy its keys into the new file, or run pnpm openmapx data generate-api-keys and enter them again.`,
    };
  }
  return null;
}

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
  /** What preparing the default keys file did; absent with an explicit output path. */
  keysFile?: EnsureTransitousApiKeysResult;
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
  // The keys data-manager reads, carried over from the checkout the first time.
  const keysFile = opts.outputPath ? undefined : ensureTransitousApiKeysFile(opts.rootDir);
  const outputPath = opts.outputPath
    ? assertInsideRoot(resolve(paths.root, opts.outputPath), paths.root)
    : (keysFile as EnsureTransitousApiKeysResult).path;

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
  // Replaced through a temporary in the same directory: a running data-manager
  // reads the new keys at its next run through its directory mount.
  atomicWrite(outputPath, `${JSON.stringify(rendered, null, 2)}\n`, TRANSITOUS_API_KEYS_MODE);

  return {
    outputPath,
    catalogDir,
    requiredCount: requiredKeys.length,
    preservedCount,
    droppedCount,
    ...(keysFile ? { keysFile } : {}),
  };
}

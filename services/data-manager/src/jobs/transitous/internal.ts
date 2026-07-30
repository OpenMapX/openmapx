import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_TRANSITOUS_REPO_URL,
  type PruneUnresolvableSourcesOptions,
  pruneUnresolvableSources,
  resetCatalog,
  safeDirArgs,
  TRANSITOUS_CATALOG_DIR,
  TRANSITOUS_DOWNLOADS_DIR,
  type TransitousFeedFile,
  type TransitousFeedSource,
} from "@openmapx/transitous-core";
import { execa } from "execa";
import type { CommandRunner, FeedDownloadFailure, FeedFileEntry, JobLogger } from "./types.js";

export type { PruneUnresolvableSourcesOptions, TransitousFeedFile, TransitousFeedSource };
// Shared Transitous helpers now live in @openmapx/transitous-core; re-export the
// ones daemon modules still import from here so their import paths don't churn.
export {
  DEFAULT_TRANSITOUS_REPO_URL,
  pruneUnresolvableSources,
  safeDirArgs,
  TRANSITOUS_CATALOG_DIR,
  TRANSITOUS_DOWNLOADS_DIR,
};
/** Discard in-place catalog edits. Kept name; backed by the shared helper. */
export const resetTransitousCatalog = resetCatalog;

/**
 * Marker file the motis-import stage writes into the staging data
 * directory after a successful `motis import`. Promote uses its
 * presence as a strong signal that the volume is safe to swap. JSON so
 * operators can read it; the body holds the import timestamp + duration.
 */
export const IMPORT_MARKER_FILE = ".data-manager-import.ok.json";

export const RAW_BASE = "https://raw.githubusercontent.com/public-transport/transitous/main";
export const DEFAULT_TRANSITOUS_API_KEYS_PATH = "/config/transitous/api-keys.json";
export const DEFAULT_TRANSITOUS_FEEDS_OVERLAY_PATH = "/data/overrides/feeds-overlay.json";

// Match published GTFS / NeTEx archives only. `.tmp-*.gtfs.zip` and any
// other dotfile-prefixed name is excluded.
export const GTFS_ARCHIVE_RE = /^[^.][^/]*\.(gtfs|netex)\.zip$/i;

export async function defaultRunner(
  command: string,
  args: string[],
  opts: { cwd?: string; stdio?: "inherit" | "pipe" },
): Promise<void> {
  await execa(command, args, { cwd: opts.cwd, stdio: opts.stdio ?? "pipe" });
}

export function normaliseCountries(countries: string[]): string[] {
  return [...new Set(countries.map((country) => country.trim().toLowerCase()).filter(Boolean))];
}

/**
 * Parse the `TRANSITOUS_COUNTRIES` env var (comma-separated) into a country
 * list. Shared by the cron bootstrap and the `/transit/sync` API so a manual
 * trigger with no explicit countries scopes to the deployment's region instead
 * of fetching every country.
 */
export function parseTransitousCountriesEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.TRANSITOUS_COUNTRIES ?? "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
}

interface TransitlandAtlasFeedFile {
  feeds?: Array<{
    id?: string;
    spec?: string;
    urls?: Record<string, string | undefined>;
    license?: Record<string, unknown>;
  }>;
}

interface AtlasSourceMetadata {
  spec: string;
  originUrl?: string;
  license?: Record<string, unknown>;
}

export interface GtfsArchiveSnapshot {
  path: string;
  id: string;
  sizeBytes: number;
}

export async function readGitHeadSha(catalogDir: string): Promise<string> {
  try {
    const { stdout } = await execa(
      "git",
      [...safeDirArgs(catalogDir), "-C", catalogDir, "rev-parse", "HEAD"],
      { stdio: "pipe" },
    );
    return stdout.trim();
  } catch {
    return "";
  }
}

export function readTransitlandAtlasSha(catalogDir: string): string | undefined {
  const headFile = join(catalogDir, ".git", "modules", "transitland-atlas", "HEAD");
  if (!existsSync(headFile)) return undefined;
  try {
    const raw = readFileSync(headFile, "utf-8").trim();
    if (/^[0-9a-f]{7,64}$/i.test(raw)) return raw;
    return undefined;
  } catch {
    return undefined;
  }
}

export function ensureTransitousWorkdirs(
  catalogDir: string,
  gtfsDir: string,
  downloadsDir: string,
): void {
  mkdirSync(gtfsDir, { recursive: true });
  mkdirSync(downloadsDir, { recursive: true });
  const outDir = join(catalogDir, "out");
  const cacheDir = join(catalogDir, "downloads");
  if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  if (existsSync(cacheDir)) rmSync(cacheDir, { recursive: true, force: true });
  symlinkSync(gtfsDir, outDir, "dir");
  symlinkSync(downloadsDir, cacheDir, "dir");
}

export function applyApiKeysOverlay(catalogDir: string, overlayPath: string): number {
  if (!existsSync(overlayPath)) return 0;
  let overlay: Record<string, string>;
  try {
    overlay = JSON.parse(readFileSync(overlayPath, "utf-8")) as Record<string, string>;
  } catch {
    return 0;
  }

  let applied = 0;
  for (const [keyPath, rawValue] of Object.entries(overlay)) {
    const apiKey = rawValue.trim();
    if (!apiKey) continue;
    const slashIndex = keyPath.indexOf("/");
    if (slashIndex <= 0) continue;

    const region = keyPath.slice(0, slashIndex);
    const sourceName = keyPath.slice(slashIndex + 1);
    const feedPath = join(catalogDir, "feeds", `${region}.json`);
    if (!existsSync(feedPath)) continue;

    let data: TransitousFeedFile;
    try {
      data = JSON.parse(readFileSync(feedPath, "utf-8")) as TransitousFeedFile;
    } catch {
      continue;
    }

    let modified = false;
    for (const source of data.sources ?? []) {
      if (source.name !== sourceName) continue;
      if (!source["transitland-atlas-id"]) continue;
      source["api-key"] = apiKey;
      if (source.skip) delete source.skip;
      modified = true;
    }

    if (!modified) continue;
    writeFileSync(feedPath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
    applied++;
  }

  return applied;
}

export function sourceIdForFailure(
  country: string,
  sourceName: string | undefined,
  fallback: string,
): string {
  const base = (sourceName ?? fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
  return `${country}_${base || fallback.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
}

function buildTransitlandAtlasSpecIndex(catalogDir: string): Map<string, AtlasSourceMetadata> {
  const index = new Map<string, AtlasSourceMetadata>();
  const atlasFeedsDir = join(catalogDir, "transitland-atlas", "feeds");
  if (!existsSync(atlasFeedsDir)) return index;

  for (const fileName of readdirSync(atlasFeedsDir)) {
    if (!fileName.endsWith(".json")) continue;
    const filePath = join(atlasFeedsDir, fileName);
    let payload: TransitlandAtlasFeedFile;
    try {
      payload = JSON.parse(readFileSync(filePath, "utf-8")) as TransitlandAtlasFeedFile;
    } catch {
      continue;
    }

    for (const feed of payload.feeds ?? []) {
      if (!feed.id) continue;
      const urls = feed.urls ?? {};
      const spec = feed.spec?.toLowerCase() ?? (urls.static_current ? "gtfs" : undefined);
      if (!spec && !urls.gbfs_auto_discovery) continue;
      index.set(feed.id, {
        spec: spec ?? "gbfs",
        originUrl: urls.static_current ?? urls.gbfs_auto_discovery,
        license: feed.license,
      });
    }
  }

  return index;
}

function resolveSourceSpec(
  source: TransitousFeedSource,
  atlasSpecIndex: Map<string, AtlasSourceMetadata>,
): string {
  if (source.spec?.trim()) return source.spec.trim().toLowerCase();
  if (source.type === "transitland-atlas") {
    const atlasId = source["transitland-atlas-id"];
    if (atlasId) {
      const atlasSpec = atlasSpecIndex.get(atlasId)?.spec;
      if (atlasSpec) return atlasSpec;
    }
  }
  return "gtfs";
}

function isSupportedScheduleSource(
  source: TransitousFeedSource,
  atlasSpecIndex: Map<string, AtlasSourceMetadata>,
): boolean {
  const spec = resolveSourceSpec(source, atlasSpecIndex);
  return spec === "gtfs" || spec === "netex";
}

function activeScheduleSources(
  feedId: string,
  country: string,
  feed: TransitousFeedFile,
  atlasSpecIndex: Map<string, AtlasSourceMetadata>,
): FeedFileEntry["activeScheduleSources"] {
  return (feed.sources ?? []).flatMap((source, index) => {
    if (source.skip || !isSupportedScheduleSource(source, atlasSpecIndex)) return [];
    const fallback = `${feedId}_${index + 1}`;
    const atlas = source["transitland-atlas-id"]
      ? atlasSpecIndex.get(source["transitland-atlas-id"])
      : undefined;
    return [
      {
        id: sourceIdForFailure(country, source.name, fallback),
        sourceId: source["openmapx-source-id"] ?? `catalog:${feedId}:${source.name ?? fallback}`,
        region: feedId,
        name: source.name ?? fallback,
        format: resolveSourceSpec(source, atlasSpecIndex) === "netex" ? "netex" : "gtfs",
        origin: source["openmapx-origin"] === "operator" ? "operator" : "catalog",
        originUrl: source["url-override"] ?? source.url ?? atlas?.originUrl,
        license: source.license ?? atlas?.license,
      },
    ];
  });
}

export function listTransitousFeedFiles(catalogDir: string): FeedFileEntry[] {
  const feedsDir = join(catalogDir, "feeds");
  if (!existsSync(feedsDir)) {
    throw new Error(`Transitous catalog missing feeds directory: ${feedsDir}`);
  }
  const atlasSpecIndex = buildTransitlandAtlasSpecIndex(catalogDir);

  return readdirSync(feedsDir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const id = name.replace(/\.json$/i, "");
      const country = id.split(/[.-]/)[0]?.toLowerCase() ?? id.toLowerCase();
      const entry: FeedFileEntry = {
        id,
        country,
        path: join("feeds", name),
        url: `${RAW_BASE}/feeds/${name}`,
        activeScheduleSources: [],
      };

      try {
        const filePath = join(feedsDir, name);
        const feed = JSON.parse(readFileSync(filePath, "utf-8")) as TransitousFeedFile;
        return {
          ...entry,
          activeScheduleSources: activeScheduleSources(id, country, feed, atlasSpecIndex),
        };
      } catch (error) {
        return {
          ...entry,
          activeScheduleSources: [
            {
              id,
              sourceId: `catalog:${id}:${id}`,
              region: id,
              name: id,
              format: "gtfs",
              origin: "catalog",
            },
          ],
          parseFailure: {
            id,
            country,
            url: entry.url,
            message: `Failed to parse Transitous feed file ${name}: ${(error as Error).message}`,
          },
        };
      }
    });
}

function escapedRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function failedSourceIdsFromPipelineError(feed: FeedFileEntry, message: string): string[] {
  const names = new Set<string>();
  const regionPrefix = escapedRegex(feed.id);
  const sourceErrorPattern = new RegExp(
    `Error: Could not (?:fetch|postprocess) ${regionPrefix}-(.+?):`,
    "g",
  );
  let match: RegExpExecArray | null;
  while (true) {
    match = sourceErrorPattern.exec(message);
    if (!match) break;
    const name = match[1]?.trim();
    if (name) names.add(name);
  }

  if (names.size > 0) {
    return [...names].map((name) => sourceIdForFailure(feed.country, name, feed.id));
  }

  if (feed.activeScheduleSources.length === 1) {
    return [feed.activeScheduleSources[0].id];
  }
  return [feed.id];
}

export async function runFetchPipeline(
  catalogDir: string,
  feeds: FeedFileEntry[],
  runner: CommandRunner,
  logger: JobLogger,
): Promise<FeedDownloadFailure[]> {
  const feedProxyKeyFile = process.env.TRANSITOUS_FEED_PROXY_KEY_FILE;
  if (feedProxyKeyFile && !existsSync(feedProxyKeyFile)) {
    logger.warn(
      `transitous-pipeline: TRANSITOUS_FEED_PROXY_KEY_FILE=${feedProxyKeyFile} does not exist; encrypted feeds will be skipped by fetch.py`,
    );
  }
  const failures: FeedDownloadFailure[] = [];
  for (const feed of feeds) {
    try {
      await runner("python3", ["./src/fetch.py", feed.path], { cwd: catalogDir, stdio: "pipe" });
    } catch (error) {
      const message = (error as Error).message;
      for (const id of failedSourceIdsFromPipelineError(feed, message)) {
        failures.push({
          id,
          country: feed.country,
          url: feed.url,
          message,
        });
      }
    }
  }
  return failures;
}

export async function garbageCollectTransitousOutputs(
  catalogDir: string,
  runner: CommandRunner,
): Promise<void> {
  const gcScript = join(catalogDir, "src", "garbage-collect.py");
  if (!existsSync(gcScript)) return;
  try {
    await runner("python3", ["./src/garbage-collect.py", "--non-interactive"], {
      cwd: catalogDir,
      stdio: "pipe",
    });
  } catch {
    // Best effort only.
  }
}

export function pruneFeedsOutsideCountryFilter(gtfsDir: string, countries: string[]): void {
  if (countries.length === 0 || !existsSync(gtfsDir)) return;
  const allowed = new Set(countries);
  for (const name of readdirSync(gtfsDir)) {
    if (!GTFS_ARCHIVE_RE.test(name)) continue;
    const prefix = name.split(/[_-]/)[0]?.toLowerCase();
    if (!prefix || allowed.has(prefix)) continue;
    rmSync(join(gtfsDir, name), { force: true });
  }
}

export function pruneFeedsNotInCatalog(
  gtfsDir: string,
  countries: string[],
  expectedFeedIds: ReadonlySet<string>,
): void {
  if (!existsSync(gtfsDir)) return;
  const selected = countries.length > 0 ? new Set(countries) : null;
  for (const name of readdirSync(gtfsDir)) {
    if (!GTFS_ARCHIVE_RE.test(name)) continue;
    const prefix = name.split(/[_-]/)[0]?.toLowerCase();
    if (selected && (!prefix || !selected.has(prefix))) continue;
    const id = datasetIdFromArchive(name).toLowerCase();
    if (expectedFeedIds.has(id)) continue;
    rmSync(join(gtfsDir, name), { force: true });
  }
}

export function datasetIdFromArchive(name: string): string {
  if (name.endsWith(".gtfs.zip")) return name.slice(0, -".gtfs.zip".length);
  if (name.endsWith(".netex.zip")) return name.slice(0, -".netex.zip".length);
  return name.replace(/\.zip$/i, "");
}

export function scanGtfsArchives(gtfsDir: string): GtfsArchiveSnapshot[] {
  if (!existsSync(gtfsDir)) return [];
  return readdirSync(gtfsDir)
    .filter((name) => GTFS_ARCHIVE_RE.test(name))
    .sort()
    .map((name) => {
      const path = join(gtfsDir, name);
      return {
        path,
        id: datasetIdFromArchive(name),
        sizeBytes: statSync(path).size,
      };
    });
}

export function sumActiveGtfsSources(feeds: FeedFileEntry[]): number {
  return feeds.reduce((sum, feed) => sum + feed.activeScheduleSources.length, 0);
}

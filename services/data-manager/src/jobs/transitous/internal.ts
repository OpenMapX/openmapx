import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { TransitousRunnerScript } from "@openmapx/core/transitous-runner";
import {
  DEFAULT_TRANSITOUS_REPO_URL,
  isSafeFeedSourceName,
  type PruneUnresolvableSourcesOptions,
  pruneUnresolvableSources,
  resetCatalog,
  safeDirArgs,
  TRANSITOUS_CATALOG_DIR,
  TRANSITOUS_DOWNLOADS_DIR,
  type TransitousFeedFile,
  type TransitousFeedSource,
} from "@openmapx/transitous-core";
import {
  canonicalFeedCredentialMap,
  parseFeedCredentialMapJson,
} from "@openmapx/transitous-core/feed-credentials";
import { execa } from "execa";
import { dataWorkerSignal } from "../execution/worker-scope.js";
import type { TransitousScriptRunner } from "./script-runner.js";
import type { FeedDownloadFailure, FeedFileEntry, JobLogger } from "./types.js";

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

/**
 * The operator's Transitous API keys: an explicit path, else
 * `TRANSITOUS_API_KEYS_PATH`, else the file mounted at
 * {@link DEFAULT_TRANSITOUS_API_KEYS_PATH}.
 */
export function resolveTransitousApiKeysPath(explicit?: string): string {
  // `||`, not `??`: compose renders an unset variable as "", which must fall
  // through to the mounted default.
  return (
    explicit ||
    process.env.TRANSITOUS_API_KEYS_PATH ||
    process.env.TRANSITOUS_API_KEYS_FILE ||
    DEFAULT_TRANSITOUS_API_KEYS_PATH
  );
}

/**
 * The operator's feeds overlay: an explicit path, else
 * `TRANSITOUS_FEEDS_OVERLAY_PATH`, else `<dataDir>/overrides/feeds-overlay.json`
 * (`/data/…` in the container, `infra/docker/data/…` on the host).
 */
export function resolveTransitOverlayPath(dataDir: string, explicit?: string): string {
  // `||`, not `??`: compose renders unset vars as empty strings, and an empty
  // overlay path would make every mutation fail and every list read nothing.
  return (
    explicit ||
    process.env.TRANSITOUS_FEEDS_OVERLAY_PATH ||
    join(dataDir, "overrides", "feeds-overlay.json")
  );
}

const COUNTRY_TOKEN_RE = /^[a-z][a-z0-9_-]{0,31}$/;

// Match published GTFS / NeTEx archives only. `.tmp-*.gtfs.zip` and any
// other dotfile-prefixed name is excluded.
export const GTFS_ARCHIVE_RE = /^[^.][^/]*\.(gtfs|netex)\.zip$/i;

export async function defaultRunner(
  command: string,
  args: string[],
  opts: { cwd?: string; stdio?: "inherit" | "pipe" },
): Promise<void> {
  await execa(command, args, {
    cwd: opts.cwd,
    stdio: opts.stdio ?? "pipe",
    cancelSignal: dataWorkerSignal(),
  });
}

export function normaliseCountries(countries: string[]): string[] {
  return [
    ...new Set(
      (Array.isArray(countries) ? countries : [])
        .filter((country): country is string => typeof country === "string")
        .map((country) => country.trim().toLowerCase())
        .filter((country) => COUNTRY_TOKEN_RE.test(country)),
    ),
  ];
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

/** Keep the catalog inode/owner, but make it private before any credential bytes. */
export function writePrivateCatalogFile(feedPath: string, content: string): void {
  // No truncation on open: validate and tighten the same descriptor first.
  // NONBLOCK also lets us reject a FIFO without waiting for a reader.
  const fd = openSync(
    feedPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    0o600,
  );
  try {
    const file = fstatSync(fd);
    if (!file.isFile() || file.nlink !== 1) {
      throw new Error(`Transitous catalog file must be regular with a single link: ${feedPath}`);
    }
    fchmodSync(fd, 0o600);
    ftruncateSync(fd, 0);
    writeFileSync(fd, content, "utf-8");
  } finally {
    closeSync(fd);
  }
}

export function applyApiKeysOverlay(catalogDir: string, overlayPath: string): number {
  if (!existsSync(overlayPath)) return 0;
  const before = lstatSync(overlayPath);
  if (!before.isFile() || before.isSymbolicLink() || before.size > 65536)
    throw Error("Invalid feed credential map");
  const descriptor = openSync(
    overlayPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let overlay: Readonly<Record<string, string>>;
  try {
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size > 65536
    )
      throw Error("Feed credential map changed");
    overlay = canonicalFeedCredentialMap(
      parseFeedCredentialMapJson(readFileSync(descriptor, "utf8")),
    ).values;
    const after = fstatSync(descriptor),
      current = lstatSync(overlayPath);
    if (
      opened.dev !== current.dev ||
      opened.ino !== current.ino ||
      opened.size !== after.size ||
      opened.mtimeMs !== after.mtimeMs ||
      opened.ctimeMs !== after.ctimeMs
    )
      throw Error("Feed credential map changed");
  } finally {
    closeSync(descriptor);
  }

  let applied = 0;
  for (const [keyPath, rawValue] of Object.entries(overlay)) {
    const apiKey = rawValue;
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
    writePrivateCatalogFile(feedPath, `${JSON.stringify(data, null, 2)}\n`);
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

export function countryOfRegion(region: string): string {
  return region.split(/[.-]/)[0]?.toLowerCase() ?? region.toLowerCase();
}

export function buildTransitlandAtlasSpecIndex(
  catalogDir: string,
): Map<string, AtlasSourceMetadata> {
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

export type ScheduleSourceEntry = FeedFileEntry["activeScheduleSources"][number] & {
  requested: boolean;
};

/**
 * Single derivation for a feed file's schedule sources, shared between the
 * pipeline (active/selected inputs) and the source lifecycle API (desired
 * rows). Deriving both sides from one code path is what keeps desired and
 * active state comparable.
 */
export function scheduleSourcesForFeed(
  feedId: string,
  country: string,
  feed: TransitousFeedFile,
  atlasSpecIndex: Map<string, AtlasSourceMetadata>,
  onUnsafeName?: (message: string) => void,
): ScheduleSourceEntry[] {
  if (!isSafeFeedSourceName(feedId)) {
    onUnsafeName?.(
      `transitous: skipping feed file "${feedId}" — region is not a safe archive-name component`,
    );
    return [];
  }
  return (feed.sources ?? []).flatMap((source, index) => {
    if (!isSupportedScheduleSource(source, atlasSpecIndex)) return [];
    if (source.name !== undefined && !isSafeFeedSourceName(source.name)) {
      onUnsafeName?.(
        `transitous: skipping source "${source.name}" in ${feedId} — name is not a safe archive-name component`,
      );
      return [];
    }
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
        format:
          resolveSourceSpec(source, atlasSpecIndex) === "netex"
            ? ("netex" as const)
            : ("gtfs" as const),
        origin:
          source["openmapx-origin"] === "operator" ? ("operator" as const) : ("catalog" as const),
        originUrl: source["url-override"] ?? source.url ?? atlas?.originUrl,
        license: source.license ?? atlas?.license,
        requested: source.skip !== true,
      },
    ];
  });
}

function activeScheduleSources(
  feedId: string,
  country: string,
  feed: TransitousFeedFile,
  atlasSpecIndex: Map<string, AtlasSourceMetadata>,
  onUnsafeName?: (message: string) => void,
): FeedFileEntry["activeScheduleSources"] {
  return scheduleSourcesForFeed(feedId, country, feed, atlasSpecIndex, onUnsafeName)
    .filter((entry) => entry.requested)
    .map(({ requested: _requested, ...entry }) => entry);
}

export function listTransitousFeedFiles(
  catalogDir: string,
  onUnsafeName?: (message: string) => void,
): FeedFileEntry[] {
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
          activeScheduleSources: activeScheduleSources(
            id,
            country,
            feed,
            atlasSpecIndex,
            onUnsafeName,
          ),
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

/**
 * Dispatch one feed's acquisition. Catalog feeds name a catalog-relative feed
 * file; operator feeds name a file in the platform's own metadata staging
 * directory. Neither form lets a caller supply a path of its own.
 */
export type FeedScriptFactory = (feed: FeedFileEntry) => TransitousRunnerScript;

export const catalogFeedScript: FeedScriptFactory = (feed) => ({
  script: "fetch",
  feedPath: feed.path,
});

export const operatorFeedScript: FeedScriptFactory = (feed) => ({
  script: "fetch-operator",
  metadataName: basename(feed.path),
});

export async function runFetchPipeline(
  feeds: FeedFileEntry[],
  runScript: TransitousScriptRunner,
  logger: JobLogger,
  toScript: FeedScriptFactory = catalogFeedScript,
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
      await runScript(toScript(feed));
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
  runScript: TransitousScriptRunner,
): Promise<void> {
  const gcScript = join(catalogDir, "src", "garbage-collect.py");
  if (!existsSync(gcScript)) return;
  try {
    await runScript({ script: "garbage-collect" });
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

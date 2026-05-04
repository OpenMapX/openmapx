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
import { join, resolve } from "node:path";
import { execa } from "execa";
import type { DatasetMetadata, StateStore } from "../state.js";
import type { DownloadGtfsResult, FeedDownloadFailure } from "./download-gtfs.js";

const RAW_BASE = "https://raw.githubusercontent.com/public-transport/transitous/main";
export const DEFAULT_TRANSITOUS_REPO_URL = "https://github.com/public-transport/transitous.git";
export const DEFAULT_TRANSITOUS_API_KEYS_PATH = "/config/transitous/api-keys.json";
const TRANSITOUS_CATALOG_DIR = ".transitous-catalog";
const TRANSITOUS_DOWNLOADS_DIR = ".transitous-downloads";
// Match published GTFS / NeTEx archives only. `.tmp-*.gtfs.zip` and any
// other dotfile-prefixed name is excluded — gtfsclean writes its working
// output as `.tmp-<id>.gtfs.zip` and renames atomically at the end, so a
// half-written tmp file should never end up in the dataset registry or
// the prune scans (where its mid-rename mtime would briefly look "fresh").
const GTFS_ARCHIVE_RE = /^[^.][^/]*\.(gtfs|netex)\.zip$/i;

type CommandRunner = (
  command: string,
  args: string[],
  opts: { cwd?: string; stdio?: "inherit" | "pipe" },
) => Promise<void>;

interface TransitousFeedFileEntry {
  id: string;
  country: string;
  path: string;
  url: string;
  activeScheduleSources: TransitousActiveScheduleSource[];
  parseFailure?: FeedDownloadFailure;
}

interface TransitousFeedSource {
  name?: string;
  skip?: boolean;
  spec?: string;
  type?: string;
  url?: string;
  "api-key"?: string;
  "transitland-atlas-id"?: string;
}

interface TransitousFeedFile {
  sources?: TransitousFeedSource[];
}

interface TransitousActiveScheduleSource {
  id: string;
  name: string;
}

interface TransitlandAtlasFeedFile {
  feeds?: Array<{
    id?: string;
    urls?: Record<string, string | undefined>;
  }>;
}

interface GtfsArchiveSnapshot {
  path: string;
  id: string;
  sizeBytes: number;
}

export interface DownloadGtfsViaTransitousOptions {
  countries: string[];
  dataDir: string;
  store: StateStore;
  transitousRepoUrl?: string;
  apiKeysPath?: string;
  runner?: CommandRunner;
  now?: () => string;
}

async function defaultRunner(
  command: string,
  args: string[],
  opts: { cwd?: string; stdio?: "inherit" | "pipe" },
): Promise<void> {
  await execa(command, args, { cwd: opts.cwd, stdio: opts.stdio ?? "pipe" });
}

function normaliseCountries(countries: string[]): string[] {
  return [...new Set(countries.map((country) => country.trim().toLowerCase()).filter(Boolean))];
}

function ensureTransitousWorkdirs(catalogDir: string, gtfsDir: string, downloadsDir: string): void {
  mkdirSync(gtfsDir, { recursive: true });
  mkdirSync(downloadsDir, { recursive: true });
  const outDir = join(catalogDir, "out");
  const cacheDir = join(catalogDir, "downloads");
  if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  if (existsSync(cacheDir)) rmSync(cacheDir, { recursive: true, force: true });
  symlinkSync(gtfsDir, outDir, "dir");
  symlinkSync(downloadsDir, cacheDir, "dir");
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

async function resetTransitousCatalog(catalogDir: string, runner: CommandRunner): Promise<void> {
  try {
    await runner("git", ["-C", catalogDir, "reset", "--hard", "HEAD"], {
      cwd: catalogDir,
      stdio: "pipe",
    });
  } catch {
    // Best effort only — the fetch can still proceed against the cached catalog.
  }
}

function applyApiKeysOverlay(catalogDir: string, overlayPath: string): number {
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

function sourceIdForFailure(
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

function buildTransitlandAtlasSpecIndex(catalogDir: string): Map<string, string> {
  const index = new Map<string, string>();
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
      if (urls.static_current) {
        index.set(feed.id, "gtfs");
      } else if (urls.gbfs_auto_discovery) {
        index.set(feed.id, "gbfs");
      }
    }
  }

  return index;
}

function resolveSourceSpec(
  source: TransitousFeedSource,
  atlasSpecIndex: Map<string, string>,
): string {
  if (source.spec?.trim()) return source.spec.trim().toLowerCase();

  if (source.type === "transitland-atlas") {
    const atlasId = source["transitland-atlas-id"];
    if (atlasId) {
      const atlasSpec = atlasSpecIndex.get(atlasId);
      if (atlasSpec) return atlasSpec;
    }
  }

  // Match Transitous defaults when we cannot infer better from metadata.
  return "gtfs";
}

function isSupportedScheduleSource(
  source: TransitousFeedSource,
  atlasSpecIndex: Map<string, string>,
): boolean {
  const spec = resolveSourceSpec(source, atlasSpecIndex);
  return spec === "gtfs" || spec === "netex";
}

function activeScheduleSources(
  feedId: string,
  country: string,
  feed: TransitousFeedFile,
  atlasSpecIndex: Map<string, string>,
): TransitousActiveScheduleSource[] {
  return (feed.sources ?? []).flatMap((source, index) => {
    if (source.skip || !isSupportedScheduleSource(source, atlasSpecIndex)) return [];
    const fallback = `${feedId}_${index + 1}`;
    return [
      {
        id: sourceIdForFailure(country, source.name, fallback),
        name: source.name ?? fallback,
      },
    ];
  });
}

function listTransitousFeedFiles(catalogDir: string): TransitousFeedFileEntry[] {
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
      const entry = {
        id,
        country,
        path: join("feeds", name),
        url: `${RAW_BASE}/feeds/${name}`,
        activeScheduleSources: [] as TransitousActiveScheduleSource[],
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
          activeScheduleSources: [{ id, name: id }],
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

function failedSourceIdsFromPipelineError(
  feed: TransitousFeedFileEntry,
  message: string,
): string[] {
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

async function runFetchPipeline(
  catalogDir: string,
  feeds: TransitousFeedFileEntry[],
  runner: CommandRunner,
): Promise<FeedDownloadFailure[]> {
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

async function garbageCollectTransitousOutputs(
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
    // Best effort only — keep the fetched archives even if Transitous cleanup fails.
  }
}

function pruneFeedsOutsideCountryFilter(gtfsDir: string, countries: string[]): void {
  if (countries.length === 0 || !existsSync(gtfsDir)) return;
  const allowed = new Set(countries);
  for (const name of readdirSync(gtfsDir)) {
    if (!GTFS_ARCHIVE_RE.test(name)) continue;
    const prefix = name.split(/[_-]/)[0]?.toLowerCase();
    if (!prefix || allowed.has(prefix)) continue;
    rmSync(join(gtfsDir, name), { force: true });
  }
}

/**
 * After a fully-successful pipeline run, remove archives for feeds that the
 * Transitous catalog no longer lists (i.e. feeds that disappeared upstream).
 * Files still expected by the catalog are kept regardless of mtime, so feeds
 * fetch.py left untouched because they were already up-to-date are preserved.
 */
function pruneFeedsNotInCatalog(
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

function datasetIdFromArchive(name: string): string {
  if (name.endsWith(".gtfs.zip")) return name.slice(0, -".gtfs.zip".length);
  if (name.endsWith(".netex.zip")) return name.slice(0, -".netex.zip".length);
  return name.replace(/\.zip$/i, "");
}

/**
 * Remove store entries for GTFS feeds whose archive no longer exists on
 * disk. Called at the top of every Transitous run so a previous crash that
 * left a `.tmp-*` upsert behind, or an operator-deleted archive, doesn't
 * stay in the registry forever — the resume (failure) path of the pipeline
 * never replaces the store wholesale, so without this nudge stale entries
 * persist indefinitely.
 */
function pruneOrphanedGtfsDatasets(store: StateStore): void {
  for (const dataset of store.getAll()) {
    if (dataset.type !== "gtfs") continue;
    if (existsSync(dataset.path)) continue;
    store.remove("gtfs", dataset.id);
  }
}

function scanGtfsArchives(gtfsDir: string): GtfsArchiveSnapshot[] {
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

function toDatasetMetadata(archive: GtfsArchiveSnapshot, downloadedAt: string): DatasetMetadata {
  return {
    type: "gtfs",
    id: archive.id,
    sizeBytes: archive.sizeBytes,
    downloadedAt,
    path: archive.path,
  };
}

function sumActiveGtfsSources(feeds: TransitousFeedFileEntry[]): number {
  return feeds.reduce((sum, feed) => sum + feed.activeScheduleSources.length, 0);
}

export async function downloadGtfsViaTransitous(
  opts: DownloadGtfsViaTransitousOptions,
): Promise<DownloadGtfsResult> {
  const runner = opts.runner ?? defaultRunner;
  const now = opts.now ?? (() => new Date().toISOString());
  const countries = normaliseCountries(opts.countries);
  const gtfsDir = join(opts.dataDir, "gtfs");
  const downloadsDir = join(opts.dataDir, TRANSITOUS_DOWNLOADS_DIR);
  const catalogDir = await ensureTransitousCatalog(
    opts.dataDir,
    opts.transitousRepoUrl ?? process.env.TRANSITOUS_REPO_URL ?? DEFAULT_TRANSITOUS_REPO_URL,
    runner,
  );
  try {
    ensureTransitousWorkdirs(catalogDir, gtfsDir, downloadsDir);
    // Drop any GTFS dataset entries whose archive is no longer on disk.
    // Keeps the registry self-healing across crashes / .tmp-* renames /
    // operator deletions, even when the pipeline ends in the resume
    // (failure) branch and never gets to wholesale-replace the store.
    pruneOrphanedGtfsDatasets(opts.store);
    applyApiKeysOverlay(
      catalogDir,
      opts.apiKeysPath ?? process.env.TRANSITOUS_API_KEYS_PATH ?? DEFAULT_TRANSITOUS_API_KEYS_PATH,
    );

    const allFeedFiles = listTransitousFeedFiles(catalogDir);
    const requestedCount = sumActiveGtfsSources(allFeedFiles);
    const countryMatchedFeedFiles =
      countries.length === 0
        ? allFeedFiles
        : allFeedFiles.filter((feed) => countries.includes(feed.country));
    if (countries.length > 0 && countryMatchedFeedFiles.length === 0) {
      throw new Error(
        `Transitous catalog does not contain any feed files for countries: ${countries.join(", ")}`,
      );
    }
    const selectedFeedFiles = countryMatchedFeedFiles.filter(
      (feed) => feed.activeScheduleSources.length > 0,
    );
    const selectedCount = sumActiveGtfsSources(selectedFeedFiles);
    if (selectedCount === 0) {
      const scope =
        countries.length > 0
          ? `countries: ${countries.join(", ")}`
          : "the current Transitous catalog";
      throw new Error(`Transitous catalog does not contain any active GTFS feeds for ${scope}`);
    }
    const skippedCount = requestedCount - selectedCount;

    // No upfront purge: a crash mid-pipeline (OOM, container restart) used to
    // wipe everything before fetch.py could re-download it. Instead, the post-
    // pipeline cleanup below removes only files no longer in the catalog, and
    // only when the run completed without failures.
    //
    // Snapshot the mtime of every existing archive so that, on a partial
    // failure, we can tell which entries fetch.py actually rewrote during
    // this run versus archives left over from a previous run. This is more
    // robust than a single pipeline-start timestamp because the test/fixture
    // setup (and very fast pipelines) can land both file mtime and start
    // timestamp inside the same millisecond.
    const preFetchMtimes = new Map<string, number>();
    for (const archive of scanGtfsArchives(gtfsDir)) {
      try {
        preFetchMtimes.set(archive.path, statSync(archive.path).mtimeMs);
      } catch {
        // Best effort — if we can't read mtime now we'll treat the archive as
        // pre-existing and only count it as fresh if it gains a newer mtime.
      }
    }

    const parseFailures = selectedFeedFiles.flatMap((feed) =>
      feed.parseFailure ? [feed.parseFailure] : [],
    );
    const runnableFeedFiles = selectedFeedFiles.filter((feed) => !feed.parseFailure);
    const failures = [
      ...parseFailures,
      ...(await runFetchPipeline(catalogDir, runnableFeedFiles, runner)),
    ];

    const refreshedAt = now();
    const expectedFeedIds = new Set(
      selectedFeedFiles.flatMap((feed) =>
        feed.activeScheduleSources.map((source) => source.id.toLowerCase()),
      ),
    );

    if (failures.length === 0) {
      // Full success — safe to garbage-collect Transitous intermediates and
      // prune archives the catalog no longer lists. The store is replaced
      // wholesale so it reflects exactly what's on disk.
      await garbageCollectTransitousOutputs(catalogDir, runner);
      pruneFeedsNotInCatalog(gtfsDir, countries, expectedFeedIds);
      pruneFeedsOutsideCountryFilter(gtfsDir, countries);

      const currentArchives = scanGtfsArchives(gtfsDir);
      const datasets = currentArchives.map((archive) => toDatasetMetadata(archive, refreshedAt));
      opts.store.replaceType("gtfs", datasets);
      return {
        requestedCount,
        selectedCount,
        skippedCount,
        downloaded: datasets,
        failures: [],
        partialSuccess: false,
      };
    }

    // Partial / full failure — preserve every existing archive so the next
    // run can resume rather than start over. Only archives modified during
    // this run are reported as freshly downloaded; existing archives keep
    // their prior `downloadedAt` because we don't touch the store for them.
    const currentArchives = scanGtfsArchives(gtfsDir);
    const freshlyWritten = currentArchives.filter((archive) => {
      let mtimeMs: number;
      try {
        mtimeMs = statSync(archive.path).mtimeMs;
      } catch {
        return false;
      }
      const previous = preFetchMtimes.get(archive.path);
      return previous === undefined || mtimeMs > previous;
    });
    const downloaded = freshlyWritten.map((archive) => toDatasetMetadata(archive, refreshedAt));
    for (const dataset of downloaded) {
      opts.store.upsert(dataset);
    }

    return {
      requestedCount,
      selectedCount,
      skippedCount,
      downloaded,
      failures,
      partialSuccess: downloaded.length > 0 && failures.length > 0,
    };
  } finally {
    await resetTransitousCatalog(catalogDir, runner);
  }
}

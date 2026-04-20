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
const GTFS_ARCHIVE_RE = /\.(gtfs|netex)\.zip$/i;

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
  activeScheduleSourceIds: string[];
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

function isSupportedScheduleSource(source: TransitousFeedSource): boolean {
  const spec = (source.spec ?? "gtfs").toLowerCase();
  return spec === "gtfs" || spec === "netex";
}

function activeScheduleSourceIds(
  feedId: string,
  country: string,
  feed: TransitousFeedFile,
): string[] {
  return (feed.sources ?? [])
    .filter((source) => !source.skip && isSupportedScheduleSource(source))
    .map((source, index) => sourceIdForFailure(country, source.name, `${feedId}_${index + 1}`));
}

function listTransitousFeedFiles(catalogDir: string): TransitousFeedFileEntry[] {
  const feedsDir = join(catalogDir, "feeds");
  if (!existsSync(feedsDir)) {
    throw new Error(`Transitous catalog missing feeds directory: ${feedsDir}`);
  }

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
        activeScheduleSourceIds: [] as string[],
      };

      try {
        const filePath = join(feedsDir, name);
        const feed = JSON.parse(readFileSync(filePath, "utf-8")) as TransitousFeedFile;
        return {
          ...entry,
          activeScheduleSourceIds: activeScheduleSourceIds(id, country, feed),
        };
      } catch (error) {
        return {
          ...entry,
          activeScheduleSourceIds: [id],
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
      for (const id of feed.activeScheduleSourceIds) {
        failures.push({
          id,
          country: feed.country,
          url: feed.url,
          message: (error as Error).message,
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

function purgeFeedsForCountryFilter(gtfsDir: string, countries: string[]): void {
  if (!existsSync(gtfsDir)) return;
  const selected = countries.length > 0 ? new Set(countries) : null;
  for (const name of readdirSync(gtfsDir)) {
    if (!GTFS_ARCHIVE_RE.test(name)) continue;
    const prefix = name.split(/[_-]/)[0]?.toLowerCase();
    if (selected && (!prefix || !selected.has(prefix))) continue;
    rmSync(join(gtfsDir, name), { force: true });
  }
}

function datasetIdFromArchive(name: string): string {
  if (name.endsWith(".gtfs.zip")) return name.slice(0, -".gtfs.zip".length);
  if (name.endsWith(".netex.zip")) return name.slice(0, -".netex.zip".length);
  return name.replace(/\.zip$/i, "");
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
  return feeds.reduce((sum, feed) => sum + feed.activeScheduleSourceIds.length, 0);
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
      (feed) => feed.activeScheduleSourceIds.length > 0,
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

    // Treat the selected-country refresh as authoritative: clear the matching
    // archives first so disappeared or failed feeds do not linger as stale data.
    purgeFeedsForCountryFilter(gtfsDir, countries);
    const parseFailures = selectedFeedFiles.flatMap((feed) =>
      feed.parseFailure ? [feed.parseFailure] : [],
    );
    const runnableFeedFiles = selectedFeedFiles.filter((feed) => !feed.parseFailure);
    const failures = [
      ...parseFailures,
      ...(await runFetchPipeline(catalogDir, runnableFeedFiles, runner)),
    ];
    if (failures.length === 0) {
      await garbageCollectTransitousOutputs(catalogDir, runner);
    }
    pruneFeedsOutsideCountryFilter(gtfsDir, countries);

    const refreshedAt = now();
    const currentArchives = scanGtfsArchives(gtfsDir);
    const datasets = currentArchives.map((archive) => toDatasetMetadata(archive, refreshedAt));
    opts.store.replaceType("gtfs", datasets);
    return {
      requestedCount,
      selectedCount,
      skippedCount,
      downloaded: datasets,
      failures,
      partialSuccess: datasets.length > 0 && failures.length > 0,
    };
  } finally {
    await resetTransitousCatalog(catalogDir, runner);
  }
}

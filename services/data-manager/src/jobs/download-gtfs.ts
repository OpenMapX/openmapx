import { mkdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { DatasetMetadata, StateStore } from "../state.js";
import { curlAtomic } from "./atomic-download.js";

export interface FeedDescriptor {
  id: string;
  country: string;
  url: string;
}

export function slugify(url: string): string {
  return basename(url).replace(/\.zip$/i, "");
}

export function filterFeedsByCountry(
  feeds: FeedDescriptor[],
  countries: string[],
): FeedDescriptor[] {
  if (countries.length === 0) return feeds;
  const set = new Set(countries.map((c) => c.toLowerCase()));
  return feeds.filter((f) => set.has(f.country.toLowerCase()));
}

/**
 * Normalise feed archive names to the Transitous/MOTIS convention used by the
 * config generator (`*.gtfs.zip` / `*.netex.zip`).
 */
function feedArchiveFilename(id: string): string {
  const trimmed = id.trim();
  const withoutZip = trimmed.replace(/\.zip$/i, "");
  if (/\.(gtfs|netex)$/i.test(withoutZip)) {
    return `${withoutZip}.zip`;
  }
  return `${withoutZip}.gtfs.zip`;
}

/**
 * Reject feed ids that would escape the `gtfs/` directory when turned into a
 * filename. Mirrors the guard on `DELETE /datasets/gtfs/:slug` (api.ts) so the
 * download path can't write outside `<dataDir>/gtfs`.
 */
function assertSafeFeedId(id: string): void {
  const trimmed = id.trim();
  if (
    !trimmed ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("..") ||
    trimmed.includes("\0")
  ) {
    throw new Error(`invalid feed id "${id}": must not contain path separators or ".."`);
  }
}

/**
 * Reject feed URLs whose scheme isn't http(s). `curlAtomic` shells out to
 * `curl`, which would otherwise honor `file://`, `gopher://`, `dict://`, etc.
 * Host is intentionally NOT restricted — self-hosted deployments may mirror
 * feeds on an internal host.
 */
function assertHttpFeedUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`invalid feed url "${url}"`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`feed url must use http(s): "${url}"`);
  }
}

export interface DownloadGtfsOptions {
  feeds: FeedDescriptor[];
  countries: string[];
  dataDir: string;
  store: StateStore;
  concurrency?: number;
  downloader?: (url: string, targetPath: string) => Promise<void>;
  now?: () => string;
}

export interface FeedDownloadFailure {
  id: string;
  country: string;
  url: string;
  message: string;
}

export interface DownloadGtfsResult {
  requestedCount: number;
  selectedCount: number;
  skippedCount: number;
  downloaded: DatasetMetadata[];
  failures: FeedDownloadFailure[];
  partialSuccess: boolean;
}

export async function downloadGtfs(opts: DownloadGtfsOptions): Promise<DownloadGtfsResult> {
  const targetDir = join(opts.dataDir, "gtfs");
  mkdirSync(targetDir, { recursive: true });

  const filtered = filterFeedsByCountry(opts.feeds, opts.countries);
  const concurrency = opts.concurrency ?? 5;
  const downloader = opts.downloader ?? curlAtomic;
  const now = opts.now ?? (() => new Date().toISOString());
  const downloaded: DatasetMetadata[] = [];
  const failures: FeedDownloadFailure[] = [];

  for (let i = 0; i < filtered.length; i += concurrency) {
    const batch = filtered.slice(i, i + concurrency);
    const settled = await Promise.allSettled(
      batch.map(async (feed) => {
        assertSafeFeedId(feed.id);
        assertHttpFeedUrl(feed.url);
        const targetPath = join(targetDir, feedArchiveFilename(feed.id));
        await downloader(feed.url, targetPath);
        const sizeBytes = statSync(targetPath).size;
        const meta: DatasetMetadata = {
          type: "gtfs",
          id: feed.id,
          url: feed.url,
          sizeBytes,
          downloadedAt: now(),
          path: targetPath,
        };
        opts.store.upsert(meta);
        return meta;
      }),
    );

    for (const [index, result] of settled.entries()) {
      const feed = batch[index];
      if (!feed) continue;
      if (result.status === "fulfilled") {
        downloaded.push(result.value);
        continue;
      }
      failures.push({
        id: feed.id,
        country: feed.country,
        url: feed.url,
        message: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  }

  return {
    requestedCount: opts.feeds.length,
    selectedCount: filtered.length,
    skippedCount: opts.feeds.length - filtered.length,
    downloaded,
    failures,
    partialSuccess: downloaded.length > 0 && failures.length > 0,
  };
}

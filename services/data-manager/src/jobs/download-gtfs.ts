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
        const targetPath = join(targetDir, `${feed.id}.zip`);
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

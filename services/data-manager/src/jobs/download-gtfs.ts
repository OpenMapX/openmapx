import { mkdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { execa } from "execa";
import type { DatasetMetadata, StateStore } from "../state.js";

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
}

export async function downloadGtfs(opts: DownloadGtfsOptions): Promise<DatasetMetadata[]> {
  const targetDir = join(opts.dataDir, "gtfs");
  mkdirSync(targetDir, { recursive: true });

  const filtered = filterFeedsByCountry(opts.feeds, opts.countries);
  const concurrency = opts.concurrency ?? 5;
  const results: DatasetMetadata[] = [];

  for (let i = 0; i < filtered.length; i += concurrency) {
    const batch = filtered.slice(i, i + concurrency);
    const downloaded = await Promise.all(
      batch.map(async (feed) => {
        const targetPath = join(targetDir, `${feed.id}.zip`);
        await execa("curl", ["-fSL", "-o", targetPath, feed.url], { stdio: "inherit" });
        const sizeBytes = statSync(targetPath).size;
        const meta: DatasetMetadata = {
          type: "gtfs",
          id: feed.id,
          url: feed.url,
          sizeBytes,
          downloadedAt: new Date().toISOString(),
          path: targetPath,
        };
        opts.store.upsert(meta);
        return meta;
      }),
    );
    results.push(...downloaded);
  }

  return results;
}

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TransitousFeedFile } from "./feed-source.js";
import type { TransitousLogger } from "./runner.js";

/**
 * Mirror mode reuses the build pipeline but replaces fetch.py (download each
 * origin feed + gtfsclean — the slow, fragile step) with a download of
 * Transitous's already-cleaned `*.gtfs.zip` / `*.netex.zip` artifacts from its
 * published output. The MOTIS config, attribution, and feed-proxy are still
 * generated from the catalog clone, so only the archive fetch differs.
 *
 * Archives are fetched directly by URL (`<base>/<region>_<name>.<spec>.zip`),
 * one per feed source. A directory crawl of Transitous's published autoindex is
 * deliberately avoided: it has thousands of entries and recursive `wget -A`
 * silently matched nothing against it.
 */

/** One feed source to mirror, published as `<region>_<name>.<spec>.zip`. */
export interface MirrorArchive {
  /** Region key = the catalog `feeds/<region>.json` basename (e.g. `de`, `us-pa`). */
  region: string;
  /** Source `name` within that feed file (e.g. `DELFI`). */
  name: string;
}

/** Downloads `url` to `dest`, throwing on any non-success (e.g. 404). */
export type ArchiveDownloader = (url: string, dest: string) => Promise<void>;

// Published archives use one of these schedule specs. We don't reliably know
// which up front (the catalog spec can differ from what upstream published), so
// probe gtfs then netex per source.
const ARCHIVE_SPECS = ["gtfs", "netex"] as const;

/** Default max concurrent archive downloads — matches data-manager's downloadGtfs. */
const DEFAULT_MIRROR_CONCURRENCY = 5;

// Source `spec` values that are not schedule data (no `.gtfs/.netex.zip`
// archive to mirror) — skip them so we don't 404-probe e.g. bikeshare feeds.
const NON_SCHEDULE_SPECS = new Set(["gbfs"]);

/** The country code of a region key — the part before the first `-` (`us-pa` → `us`). */
function countryOf(region: string): string {
  const dash = region.indexOf("-");
  return (dash === -1 ? region : region.slice(0, dash)).toLowerCase();
}

/**
 * List the schedule-feed archives to mirror by parsing the catalog's
 * `feeds/<region>.json` files. When `countries` is non-empty, only regions
 * whose country code matches are included. (A best-effort view for the CLI
 * seed; the daemon pipeline derives the same set through its richer filter.)
 */
export function listMirrorArchives(
  catalogDir: string,
  countries: readonly string[] = [],
): MirrorArchive[] {
  const feedsDir = join(catalogDir, "feeds");
  if (!existsSync(feedsDir)) return [];
  const wanted = countries.map((c) => c.toLowerCase());
  const archives: MirrorArchive[] = [];
  for (const file of readdirSync(feedsDir)) {
    if (!file.endsWith(".json")) continue;
    const region = file.slice(0, -".json".length);
    if (wanted.length > 0 && !wanted.includes(countryOf(region))) continue;
    let parsed: TransitousFeedFile;
    try {
      parsed = JSON.parse(readFileSync(join(feedsDir, file), "utf-8")) as TransitousFeedFile;
    } catch {
      continue;
    }
    for (const source of parsed.sources ?? []) {
      if (!source.name || source.skip) continue;
      if (source.spec && NON_SCHEDULE_SPECS.has(source.spec.toLowerCase())) continue;
      archives.push({ region, name: source.name });
    }
  }
  return archives;
}

/**
 * Download each archive directly from `baseUrl`, probing gtfs then netex, in
 * fixed-size concurrent batches (default {@link DEFAULT_MIRROR_CONCURRENCY}).
 * Returns the count fetched and the archives for which no published archive
 * exists (in input order). Never throws for a single missing archive — the
 * caller decides how a partial/empty result is handled.
 */
export async function mirrorArchives(opts: {
  archives: readonly MirrorArchive[];
  baseUrl: string;
  destDir: string;
  download: ArchiveDownloader;
  logger: TransitousLogger;
  /** Max concurrent downloads. Defaults to {@link DEFAULT_MIRROR_CONCURRENCY}. */
  concurrency?: number;
}): Promise<{ fetched: number; missing: MirrorArchive[] }> {
  const base = opts.baseUrl.endsWith("/") ? opts.baseUrl : `${opts.baseUrl}/`;
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_MIRROR_CONCURRENCY);

  const fetchOne = async (archive: MirrorArchive): Promise<boolean> => {
    for (const spec of ARCHIVE_SPECS) {
      const name = `${archive.region}_${archive.name}.${spec}.zip`;
      try {
        await opts.download(`${base}${name}`, join(opts.destDir, name));
        if (existsSync(join(opts.destDir, name))) return true;
      } catch {
        // No archive for this spec (404) — try the next, else count missing.
      }
    }
    return false;
  };

  let fetched = 0;
  const missing: MirrorArchive[] = [];
  for (let i = 0; i < opts.archives.length; i += concurrency) {
    const batch = opts.archives.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map(async (archive) => ({ archive, ok: await fetchOne(archive) })),
    );
    for (const { archive, ok } of results) {
      if (ok) {
        fetched += 1;
      } else {
        missing.push(archive);
        opts.logger.warn(
          `transitous-mirror: no published archive for ${archive.region}_${archive.name}`,
        );
      }
    }
  }
  return { fetched, missing };
}

/** Transitous's hosted realtime feed-proxy, baked into the generated config. */
export const TRANSITOUS_FEED_PROXY_URL = "https://rt.triptix.tech";

const RT_FEED_URL_RE = /https:\/\/rt\.triptix\.tech\/feed\/([^\s"']+)/g;

export interface HostedFeedProxyRewriteCounts {
  realtimeUrls: number;
  gbfsProxy: number;
}

/**
 * Rewrite Transitous-hosted MOTIS feed-proxy references to a local proxy.
 *
 * In addition to scoped `/feed/<id>` realtime URLs, MOTIS uses the `proxy`
 * scalar directly inside the top-level `gbfs` block for discovery and every
 * discovered sub-resource request. The transform is deliberately line based:
 * it preserves comments, quoting, line endings and unrelated/nested `proxy`
 * keys instead of parsing and re-serializing the complete upstream YAML.
 */
export function rewriteHostedFeedProxy(
  configText: string,
  feedProxyUrl: string,
  feedIds?: ReadonlySet<string>,
): { text: string; counts: HostedFeedProxyRewriteCounts } {
  const target = feedProxyUrl.trim().replace(/\/+$/, "");
  let realtimeUrls = 0;
  let text = configText.replace(RT_FEED_URL_RE, (match, rawId: string) => {
    if (feedIds) {
      let decoded = rawId;
      try {
        decoded = decodeURIComponent(rawId);
      } catch {
        // keep raw
      }
      if (!feedIds.has(rawId) && !feedIds.has(decoded)) return match;
    }
    realtimeUrls += 1;
    return `${target}/feed/${rawId}`;
  });

  let gbfsProxy = 0;
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const gbfsStart = lines.findIndex((line) => /^gbfs:\s*(?:#.*)?$/.test(line));
  if (gbfsStart !== -1) {
    let gbfsEnd = lines.length;
    for (let index = gbfsStart + 1; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (/^[^\s#][^:]*:\s*/.test(line)) {
        gbfsEnd = index;
        break;
      }
    }

    const directIndent = lines
      .slice(gbfsStart + 1, gbfsEnd)
      .filter((line) => line.trim() && !line.trimStart().startsWith("#"))
      .map((line) => line.match(/^\s*/)?.[0].length ?? 0)
      .filter((indent) => indent > 0)
      .reduce<number | undefined>(
        (minimum, indent) => (minimum === undefined ? indent : Math.min(minimum, indent)),
        undefined,
      );

    if (directIndent !== undefined) {
      for (let index = gbfsStart + 1; index < gbfsEnd; index += 1) {
        const line = lines[index] ?? "";
        if ((line.match(/^\s*/)?.[0].length ?? 0) !== directIndent) continue;
        const match = line.match(/^(\s*proxy:\s*)(["']?)([^"'#]*?)(\2)(\s*(?:#.*)?)$/);
        if (!match) continue;
        const value = match[3]?.trim();
        if (value !== TRANSITOUS_FEED_PROXY_URL) break;
        const quote = match[2] ?? "";
        lines[index] = `${match[1]}${quote}${target}${quote}${match[5] ?? ""}`;
        gbfsProxy = 1;
        break;
      }
    }
    text = lines.join(newline);
  }

  return { text, counts: { realtimeUrls, gbfsProxy } };
}

/** Return hosted `/feed/<id>` references that remain inside top-level GBFS. */
export function findHostedGbfsFeedIds(configText: string): string[] {
  const lines = configText.split(/\r?\n/);
  const start = lines.findIndex((line) => /^gbfs:\s*(?:#.*)?$/.test(line));
  if (start === -1) return [];
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^[^\s#][^:]*:\s*/.test(lines[index] ?? "")) {
      end = index;
      break;
    }
  }
  const ids = new Set<string>();
  for (const match of lines
    .slice(start + 1, end)
    .join("\n")
    .matchAll(RT_FEED_URL_RE)) {
    const rawId = match[1];
    if (!rawId) continue;
    try {
      ids.add(decodeURIComponent(rawId));
    } catch {
      ids.add(rawId);
    }
  }
  return [...ids].sort();
}

/** @deprecated Use {@link rewriteHostedFeedProxy}. */
export function rewriteRtUrls(
  configText: string,
  feedProxyUrl: string,
  feedIds?: ReadonlySet<string>,
): { text: string; replaced: number } {
  const result = rewriteHostedFeedProxy(configText, feedProxyUrl, feedIds);
  return { text: result.text, replaced: result.counts.realtimeUrls };
}

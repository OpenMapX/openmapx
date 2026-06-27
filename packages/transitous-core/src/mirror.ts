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
 * Download each archive directly from `baseUrl`, probing gtfs then netex.
 * Returns the count fetched and the archives for which no published archive
 * exists. Never throws for a single missing archive — the caller decides how a
 * partial/empty result is handled.
 */
export async function mirrorArchives(opts: {
  archives: readonly MirrorArchive[];
  baseUrl: string;
  destDir: string;
  download: ArchiveDownloader;
  logger: TransitousLogger;
}): Promise<{ fetched: number; missing: MirrorArchive[] }> {
  const base = opts.baseUrl.endsWith("/") ? opts.baseUrl : `${opts.baseUrl}/`;
  let fetched = 0;
  const missing: MirrorArchive[] = [];
  for (const archive of opts.archives) {
    let ok = false;
    for (const spec of ARCHIVE_SPECS) {
      const name = `${archive.region}_${archive.name}.${spec}.zip`;
      try {
        await opts.download(`${base}${name}`, join(opts.destDir, name));
        if (existsSync(join(opts.destDir, name))) {
          ok = true;
          break;
        }
      } catch {
        // No archive for this spec (404) — try the next, else count missing.
      }
    }
    if (ok) {
      fetched += 1;
    } else {
      missing.push(archive);
      opts.logger.warn(
        `transitous-mirror: no published archive for ${archive.region}_${archive.name}`,
      );
    }
  }
  return { fetched, missing };
}

/** Transitous's hosted realtime feed-proxy, baked into the generated config. */
export const TRANSITOUS_FEED_PROXY_URL = "https://rt.triptix.tech";

const RT_FEED_URL_RE = /https:\/\/rt\.triptix\.tech\/feed\/([^\s"']+)/g;

/**
 * Rewrite the MOTIS `config.yml` so realtime feeds flow through OUR feed-proxy
 * instead of Transitous's hosted one (`rt.triptix.tech`) — keeping realtime
 * independent of Transitous infrastructure. Used by both the daemon (build +
 * mirror) and the CLI seed.
 *
 * When `feedIds` is given, only `/feed/<id>` URLs whose id our proxy actually
 * serves are repointed (others are left on the origin proxy, so we never break
 * realtime for a feed our proxy has no config for). When omitted, every
 * `rt.triptix.tech/feed/...` URL is repointed. Returns the rewritten text and
 * the number of URLs replaced.
 */
export function rewriteRtUrls(
  configText: string,
  feedProxyUrl: string,
  feedIds?: ReadonlySet<string>,
): { text: string; replaced: number } {
  const target = feedProxyUrl.trim().replace(/\/+$/, "");
  let replaced = 0;
  const text = configText.replace(RT_FEED_URL_RE, (match, rawId: string) => {
    if (feedIds) {
      let decoded = rawId;
      try {
        decoded = decodeURIComponent(rawId);
      } catch {
        // keep raw
      }
      if (!feedIds.has(rawId) && !feedIds.has(decoded)) return match;
    }
    replaced += 1;
    return `${target}/feed/${rawId}`;
  });
  return { text, replaced };
}

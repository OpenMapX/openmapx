import { normalizeProducerUrl } from "@integrations/transit-mobility-database";
import type { BBox } from "@openmapx/core";
import { USER_AGENT_TRANSIT } from "@openmapx/core";
import { getIntegrationsByDomain } from "../../integration-host.js";
import type { CatalogFeed } from "./types";

/**
 * Provider shape registered by the `transit-mobility-database` integration
 * under the `gtfs-catalog` domain (see its `setup()`). We have to go through
 * the registry because in development the integration host imports built-in
 * modules with an mtime query string for HMR — a direct
 * `import { getMdbCatalogFeeds } from "@integrations/transit-mobility-database"`
 * pulls a separate module instance whose `state.client` is never initialized,
 * so the call would always return `[]`.
 */
interface MdbCatalogProvider {
  id: string;
  listFeeds: () => Promise<CatalogFeed[]>;
}

async function getMdbCatalogFeeds(): Promise<CatalogFeed[]> {
  const out: CatalogFeed[] = [];
  for (const integration of getIntegrationsByDomain("gtfs-catalog")) {
    const providers = (integration.providers.get("gtfs-catalog") ?? []) as MdbCatalogProvider[];
    for (const provider of providers) {
      try {
        const feeds = await provider.listFeeds();
        out.push(...feeds);
      } catch (err) {
        console.warn(`[gtfs-catalog] provider "${provider.id}" listFeeds failed:`, err);
      }
    }
  }
  return out;
}

const GITHUB_API = "https://api.github.com";
const RAW_BASE = "https://raw.githubusercontent.com/public-transport/transitous/main";
const TIMEOUT_MS = 15_000;
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** ISO country code → approximate bounding box. */
const COUNTRY_BBOXES: Record<string, BBox> = {
  at: [9.53, 46.37, 17.16, 49.02],
  be: [2.54, 49.49, 6.41, 51.51],
  bg: [22.36, 41.24, 28.61, 44.22],
  ch: [5.96, 45.82, 10.49, 47.81],
  cz: [12.09, 48.55, 18.86, 51.06],
  de: [5.87, 47.27, 15.04, 55.06],
  dk: [8.07, 54.56, 15.2, 57.75],
  ee: [21.76, 57.52, 28.21, 59.68],
  es: [-9.39, 35.95, 3.35, 43.75],
  fi: [20.55, 59.81, 31.59, 70.09],
  fr: [-5.14, 42.33, 8.23, 51.09],
  gb: [-8.17, 49.96, 1.75, 58.64],
  gr: [19.37, 34.8, 29.65, 41.75],
  hr: [13.5, 42.39, 19.45, 46.55],
  hu: [16.11, 45.74, 22.9, 48.59],
  ie: [-10.48, 51.42, -5.99, 55.38],
  it: [6.63, 36.65, 18.52, 47.09],
  lt: [20.93, 53.9, 26.84, 56.45],
  lu: [5.73, 49.44, 6.53, 50.18],
  lv: [20.97, 55.67, 28.24, 58.08],
  nl: [3.36, 50.75, 7.21, 53.47],
  no: [4.63, 57.96, 31.08, 71.19],
  pl: [14.12, 49.0, 24.15, 54.83],
  pt: [-9.5, 36.96, -6.19, 42.15],
  ro: [20.26, 43.62, 29.69, 48.27],
  se: [11.11, 55.34, 24.17, 69.06],
  si: [13.38, 45.42, 16.61, 46.88],
  sk: [16.83, 47.73, 22.57, 49.6],
  us: [-124.85, 24.4, -66.88, 49.38],
  ca: [-141.0, 41.68, -52.62, 83.11],
  au: [113.34, -43.63, 153.64, -10.67],
  nz: [166.43, -47.29, 178.57, -34.39],
  jp: [129.41, 31.03, 145.54, 45.55],
};

let cachedFeeds: CatalogFeed[] | null = null;
let lastFetchedAt = 0;

async function fetchJson<T>(url: string): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { "User-Agent": USER_AGENT_TRANSIT };
    if (process.env.GITHUB_TOKEN) {
      headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    }
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { "User-Agent": USER_AGENT_TRANSIT };
    if (process.env.GITHUB_TOKEN) {
      headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    }
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

interface GitHubTreeEntry {
  path: string;
  type: string;
}

interface TransitousFeedSource {
  name: string;
  type: string;
  url?: string;
  spec?: string;
  license?: { "spdx-identifier"?: string; url?: string };
  skip?: boolean;
}

interface TransitousFeedFile {
  sources: TransitousFeedSource[];
}

function slugify(name: string, countryCode: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
  return `${countryCode}_${base}`;
}

function secondSundayOfDecemberUtc(year: number): Date {
  const date = new Date(Date.UTC(year, 11, 1));
  while (date.getUTCDay() !== 0) {
    date.setUTCDate(date.getUTCDate() + 1);
  }
  date.setUTCDate(date.getUTCDate() + 7);
  return date;
}

function swissTimetableYear(now = new Date()): number {
  const year = now.getUTCFullYear();
  return now >= secondSundayOfDecemberUtc(year) ? year + 1 : year;
}

function buildSwissOfficialFeeds(now = new Date()): CatalogFeed[] {
  const timetableYear = swissTimetableYear(now);
  return [
    {
      id: `opentransportdata-swiss:ch:timetable-${timetableYear}-gtfs2020`,
      name: `Switzerland Timetable ${timetableYear} (GTFS2020)`,
      source: "opentransportdata-swiss",
      countryCode: "ch",
      url: `https://data.opentransportdata.swiss/en/dataset/timetable-${timetableYear}-gtfs2020/permalink`,
      license: "Open data platform mobility Switzerland terms of use",
      bbox: COUNTRY_BBOXES.ch,
    },
  ];
}

function mergeCatalogFeeds(feeds: CatalogFeed[]): CatalogFeed[] {
  // The static GTFS importer expects schedule GTFS zips. MDB also surfaces
  // GTFS-RT (protobuf streams) and GBFS (live bike/scooter JSON) rows under
  // the same `MdbCatalogFeed` shape — selecting one of those would make
  // the importer download the wrong payload. Drop them here; the integration
  // keeps them around for future non-static consumers.
  const scheduleFeeds = feeds.filter(
    (f) => f.source !== "mobilitydb" || f.dataType === undefined || f.dataType === "gtfs",
  );

  // MDB is the authoritative metadata source for any feed it lists. When the
  // same producer URL also shows up via Transitous, prefer the MDB entry so
  // license_url / mdbId / snapshot metadata flow through to import time.
  const mdbProducerUrls = new Set<string>();
  for (const feed of scheduleFeeds) {
    if (feed.source !== "mobilitydb") continue;
    const normalized = normalizeProducerUrl(feed.url);
    if (normalized) mdbProducerUrls.add(normalized);
  }

  const byId = new Map<string, CatalogFeed>();
  for (const feed of scheduleFeeds) {
    if (feed.source !== "mobilitydb") {
      const normalized = normalizeProducerUrl(feed.url);
      if (normalized && mdbProducerUrls.has(normalized)) continue;
    }
    // Attach a country bbox when we can; MDB feeds otherwise arrive without one.
    if (!feed.bbox && feed.countryCode) {
      const bbox = COUNTRY_BBOXES[feed.countryCode];
      if (bbox) feed.bbox = bbox;
    }
    byId.set(feed.id, feed);
  }

  return [...byId.values()].sort((left, right) => {
    if (left.source === "opentransportdata-swiss" && right.source !== "opentransportdata-swiss") {
      return -1;
    }
    if (right.source === "opentransportdata-swiss" && left.source !== "opentransportdata-swiss") {
      return 1;
    }
    return left.name.localeCompare(right.name);
  });
}

async function fetchTransitousCatalog(): Promise<CatalogFeed[]> {
  const tree = await fetchJson<{ tree: GitHubTreeEntry[] }>(
    `${GITHUB_API}/repos/public-transport/transitous/git/trees/main?recursive=1`,
  );
  if (!tree?.tree) return [];

  const feedFiles = tree.tree
    .filter((e) => e.type === "blob" && e.path.startsWith("feeds/") && e.path.endsWith(".json"))
    .map((e) => e.path);

  const feeds: CatalogFeed[] = [];

  // Fetch feed files in parallel (max 10 concurrent)
  const chunks: string[][] = [];
  for (let i = 0; i < feedFiles.length; i += 10) {
    chunks.push(feedFiles.slice(i, i + 10));
  }

  for (const chunk of chunks) {
    const results = await Promise.allSettled(
      chunk.map(async (path) => {
        const content = await fetchText(`${RAW_BASE}/${path}`);
        if (!content) return;

        const data = JSON.parse(content) as TransitousFeedFile;
        // Extract country code from filename: "feeds/de.json" → "de"
        const filename = path.replace("feeds/", "").replace(".json", "");
        const countryCode = filename.split("-")[0].split(".")[0].toLowerCase();

        for (const source of data.sources ?? []) {
          if (source.skip) continue;
          if (source.type !== "http") continue;
          if (!source.url) continue;
          // Only include GTFS schedule feeds (not GTFS-RT, GBFS, etc.)
          const spec = source.spec ?? "gtfs";
          if (spec !== "gtfs") continue;

          const slug = slugify(source.name, countryCode);
          feeds.push({
            id: `transitous:${filename}:${slug}`,
            name: source.name,
            source: "transitous",
            countryCode,
            url: source.url,
            license: source.license?.["spdx-identifier"] ?? source.license?.url,
            bbox: COUNTRY_BBOXES[countryCode],
          });
        }
      }),
    );

    // Log any parsing failures
    for (const result of results) {
      if (result.status === "rejected") {
        console.warn("[gtfs-catalog] Failed to parse feed file:", result.reason);
      }
    }
  }

  return feeds;
}

/**
 * Get the full catalog of available GTFS feeds.
 * Results are cached in memory and refreshed every 24 hours.
 */
export async function getCatalogFeeds(): Promise<CatalogFeed[]> {
  const now = Date.now();
  if (cachedFeeds && now - lastFetchedAt < REFRESH_INTERVAL_MS) {
    return cachedFeeds;
  }

  try {
    const [transitous, mdb] = await Promise.all([
      fetchTransitousCatalog().catch((err) => {
        console.warn("[gtfs-catalog] Transitous fetch failed:", err);
        return [];
      }),
      getMdbCatalogFeeds().catch((err) => {
        console.warn("[gtfs-catalog] Mobility Database fetch failed:", err);
        return [];
      }),
    ]);
    cachedFeeds = mergeCatalogFeeds([...buildSwissOfficialFeeds(), ...transitous, ...mdb]);
    lastFetchedAt = now;
    const bySource = cachedFeeds.reduce<Record<string, number>>((acc, f) => {
      acc[f.source] = (acc[f.source] ?? 0) + 1;
      return acc;
    }, {});
    console.log(`[gtfs-catalog] Loaded ${cachedFeeds.length} feeds (${JSON.stringify(bySource)})`);
  } catch (err) {
    console.warn("[gtfs-catalog] Failed to fetch catalog:", err);
    if (!cachedFeeds) cachedFeeds = buildSwissOfficialFeeds();
  }

  return cachedFeeds;
}

/** Search catalog feeds by country code or name. */
export async function searchCatalog(query?: string, country?: string): Promise<CatalogFeed[]> {
  const feeds = await getCatalogFeeds();
  let filtered = feeds;
  if (country) {
    const cc = country.toLowerCase();
    filtered = filtered.filter((f) => f.countryCode === cc);
  }
  if (query) {
    const q = query.toLowerCase();
    filtered = filtered.filter(
      (f) => f.name.toLowerCase().includes(q) || f.id.toLowerCase().includes(q),
    );
  }
  return filtered;
}

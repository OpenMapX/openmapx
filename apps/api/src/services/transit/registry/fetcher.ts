import { cacheGet, cacheSet, TTL } from "../../../utils/cache.js";
import type { BBox } from "../types";
import { COUNTRY_BBOXES } from "./country-bboxes";
import type { CoverageTier, ProtocolType, RegistryEntry } from "./types";

// JSDelivr CDN — mirrors GitHub without API rate limits
const JSDELIVR_LIST_URL =
  "https://data.jsdelivr.com/v1/packages/gh/public-transport/transport-apis@v1/flat";
const JSDELIVR_BASE = "https://cdn.jsdelivr.net/gh/public-transport/transport-apis@v1";
// GitHub API fallback (used only when GITHUB_TOKEN is set)
const GITHUB_TREE_URL =
  "https://api.github.com/repos/public-transport/transport-apis/git/trees/v1?recursive=1";
const RAW_BASE = "https://raw.githubusercontent.com/public-transport/transport-apis/v1";
const REGISTRY_CACHE_KEY = "transit:registry";
const MAX_CONCURRENT = 10;

const SUPPORTED_PROTOCOLS: Record<string, ProtocolType> = {
  hafasMgate: "hafasMgate",
  otpGraphQl: "otpGraphQl",
  otpRest: "otpRest",
  hafasQuery: "hafasQuery",
  efa: "efa",
  trias: "trias",
  motis: "motis",
};

interface GitTreeEntry {
  path: string;
  type: string;
}

// biome-ignore lint/suspicious/noExplicitAny: GitHub API / external JSON
function parseProtocol(typeObj: Record<string, any>): ProtocolType | null {
  for (const key of Object.keys(typeObj)) {
    if (key in SUPPORTED_PROTOCOLS) return SUPPORTED_PROTOCOLS[key];
  }
  return null;
}

function slugFromPath(path: string): string {
  // "data/at/oebb-hafas-mgate.json" → "oebb"
  const filename = path.split("/").pop()?.replace(".json", "") ?? "";
  // Strip protocol suffix: "oebb-hafas-mgate" → "oebb"
  return filename
    .replace(/-hafas-mgate$/, "")
    .replace(/-hafas-query$/, "")
    .replace(/-otp$/, "")
    .replace(/-otp-graphql$/, "")
    .replace(/-otp-rest$/, "")
    .replace(/-efa$/, "")
    .replace(/-trias$/, "")
    .replace(/-motis$/, "");
}

function idFromPath(path: string): string {
  // "data/at/oebb-hafas-mgate.json" → "at/oebb-hafas-mgate"
  return path.replace(/^data\//, "").replace(/\.json$/, "");
}

function bboxFromArea(area: { type: string; coordinates: unknown }): BBox | null {
  let minLng = 180;
  let minLat = 90;
  let maxLng = -180;
  let maxLat = -90;

  const processRings = (rings: number[][][]) => {
    for (const ring of rings) {
      for (const [lng, lat] of ring) {
        if (lng < minLng) minLng = lng;
        if (lat < minLat) minLat = lat;
        if (lng > maxLng) maxLng = lng;
        if (lat > maxLat) maxLat = lat;
      }
    }
  };

  if (area.type === "MultiPolygon") {
    const coords = area.coordinates as number[][][][];
    for (const polygon of coords) {
      processRings(polygon);
    }
  } else if (area.type === "Polygon") {
    processRings(area.coordinates as number[][][]);
  } else {
    return null;
  }

  if (minLng > maxLng) return null; // no coordinates found
  return [minLng, minLat, maxLng, maxLat];
}

function bboxFromRegions(regions: string[]): BBox | null {
  let minLng = 180;
  let minLat = 90;
  let maxLng = -180;
  let maxLat = -90;
  let found = false;
  for (const region of regions) {
    const bb = COUNTRY_BBOXES[region];
    if (!bb) continue;
    found = true;
    if (bb[0] < minLng) minLng = bb[0];
    if (bb[1] < minLat) minLat = bb[1];
    if (bb[2] > maxLng) maxLng = bb[2];
    if (bb[3] > maxLat) maxLat = bb[3];
  }
  return found ? [minLng, minLat, maxLng, maxLat] : null;
}

function parseCoverageTier(
  level: CoverageTier["level"],
  // biome-ignore lint/suspicious/noExplicitAny: external JSON
  data: any,
): CoverageTier | null {
  if (!data) return null;
  const regions: string[] = data.region ?? [];
  let bbox: BBox | null = null;
  if (data.area?.type && data.area?.coordinates) {
    bbox = bboxFromArea(data.area);
  } else if (regions.length > 0) {
    bbox = bboxFromRegions(regions);
  }
  if (!bbox) return null;
  return { level, bbox, regions };
}

// biome-ignore lint/suspicious/noExplicitAny: external JSON
function parseEntry(path: string, json: any): RegistryEntry | null {
  const protocol = parseProtocol(json.type ?? {});
  if (!protocol) return null;

  const id = idFromPath(path);
  const slug = slugFromPath(path);
  const prefix = `${slug}:`;

  const tiers: CoverageTier[] = [];
  const coverage = json.coverage ?? {};
  for (const level of ["realtimeCoverage", "regularCoverage", "anyCoverage"] as const) {
    const tier = parseCoverageTier(level, coverage[level]);
    if (tier) tiers.push(tier);
  }

  // Compute overall bbox from all tiers
  if (tiers.length === 0) return null;
  let minLng = 180;
  let minLat = 90;
  let maxLng = -180;
  let maxLat = -90;
  for (const tier of tiers) {
    if (tier.bbox[0] < minLng) minLng = tier.bbox[0];
    if (tier.bbox[1] < minLat) minLat = tier.bbox[1];
    if (tier.bbox[2] > maxLng) maxLng = tier.bbox[2];
    if (tier.bbox[3] > maxLat) maxLat = tier.bbox[3];
  }
  const bbox: BBox = [minLng, minLat, maxLng, maxLat];

  return {
    id,
    slug,
    prefix,
    name: json.name ?? slug,
    protocol,
    supportedLanguages: json.supportedLanguages ?? [],
    timezone: json.timezone,
    options: json.options ?? {},
    coverage: { bbox, tiers },
    attribution: json.attribution
      ? {
          name: json.attribution.name ?? json.name ?? "",
          homepage: json.attribution.homepage,
          license: json.attribution.license,
          isProprietary: json.attribution.isProprietary,
        }
      : undefined,
  };
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {};
    if (process.env.GITHUB_TOKEN) {
      headers.Authorization = `token ${process.env.GITHUB_TOKEN}`;
    }
    return await fetch(url, { signal: controller.signal, headers });
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch file listing via JSDelivr (no auth, no rate limits). */
async function fetchPathsFromJsdelivr(): Promise<string[]> {
  const res = await fetchWithTimeout(JSDELIVR_LIST_URL, 15_000);
  if (!res.ok) throw new Error(`JSDelivr listing: ${res.status}`);
  const json = (await res.json()) as { files: { name: string }[] };
  return json.files
    .map((f) => f.name) // e.g. "/data/at/oebb.json"
    .filter((n) => n.startsWith("/data/") && n.endsWith(".json"))
    .map((n) => n.slice(1)); // strip leading "/"
}

/** Fetch file listing via GitHub Tree API (requires GITHUB_TOKEN for reliable access). */
async function fetchPathsFromGithub(): Promise<string[]> {
  const res = await fetchWithTimeout(GITHUB_TREE_URL, 15_000);
  if (!res.ok) throw new Error(`GitHub tree: ${res.status}`);
  const tree = (await res.json()) as { tree: GitTreeEntry[] };
  return tree.tree
    .filter((e) => e.type === "blob" && e.path.startsWith("data/") && e.path.endsWith(".json"))
    .map((e) => e.path);
}

async function fetchInBatchesFrom(paths: string[], baseUrl: string): Promise<RegistryEntry[]> {
  const entries: RegistryEntry[] = [];
  for (let i = 0; i < paths.length; i += MAX_CONCURRENT) {
    const batch = paths.slice(i, i + MAX_CONCURRENT);
    const results = await Promise.allSettled(
      batch.map(async (path) => {
        const res = await fetchWithTimeout(`${baseUrl}/${path}`, 10_000);
        if (!res.ok) return null;
        const json = await res.json();
        return parseEntry(path, json);
      }),
    );
    for (const result of results) {
      if (result.status === "fulfilled" && result.value) {
        entries.push(result.value);
      }
    }
  }
  return entries;
}

export async function fetchRegistryEntries(): Promise<RegistryEntry[]> {
  let entries: RegistryEntry[] | null = null;

  // 1. Primary: JSDelivr CDN — no rate limits, no token needed
  try {
    const paths = await fetchPathsFromJsdelivr();
    entries = await fetchInBatchesFrom(paths, JSDELIVR_BASE);
    console.log(`[transit-registry] ${entries.length} entries loaded (JSDelivr)`);
  } catch (err) {
    console.warn("[transit-registry] JSDelivr unavailable, trying GitHub API:", err);
  }

  // 2. Fallback: GitHub Tree API (works reliably with GITHUB_TOKEN)
  if (!entries) {
    try {
      const paths = await fetchPathsFromGithub();
      entries = await fetchInBatchesFrom(paths, RAW_BASE);
      console.log(`[transit-registry] ${entries.length} entries loaded (GitHub API)`);
    } catch (err) {
      console.warn("[transit-registry] GitHub API unavailable, trying Redis cache:", err);
    }
  }

  if (entries && entries.length > 0) {
    await cacheSet(REGISTRY_CACHE_KEY, entries, TTL.transit.registry);
    return entries;
  }

  return loadFromRedisCache();
}

async function loadFromRedisCache(): Promise<RegistryEntry[]> {
  return (await cacheGet<RegistryEntry[]>(REGISTRY_CACHE_KEY)) ?? [];
}

import { type BBox, fetchJson } from "@openmapx/core";
import type { CacheClient } from "@openmapx/integration-framework";
import { COUNTRY_BBOXES } from "./country-bboxes";
import {
  TRANSPORT_APIS_COMMIT,
  TRANSPORT_APIS_GITHUB_TREE_URL,
  TRANSPORT_APIS_JSDELIVR_CDN_BASE,
  TRANSPORT_APIS_JSDELIVR_PKG_URL,
  TRANSPORT_APIS_RAW_BASE,
} from "./pin";
import type { CoverageTier, ProtocolType, RegistryEntry } from "./registry-types";
import { registryEndpointRejection } from "./validate-endpoint";

const REGISTRY_CACHE_KEY = "transit:registry";
const REGISTRY_CACHE_TTL = 172800; // 48 hours
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

/** Injectable cache for persistence (set from setup). */
let _cache: CacheClient | null = null;

export function setCache(cache: CacheClient): void {
  _cache = cache;
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
export function parseEntry(path: string, json: any): RegistryEntry | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;

  const type = json.type;
  const protocol = parseProtocol(
    type && typeof type === "object" && !Array.isArray(type) ? type : {},
  );
  if (!protocol) return null;

  const rawOptions = json.options;
  if (
    rawOptions !== undefined &&
    rawOptions !== null &&
    (typeof rawOptions !== "object" || Array.isArray(rawOptions))
  ) {
    console.warn(`[transit-registry] Dropping ${path}: options rejected (not-an-object)`);
    return null;
  }
  const options = (rawOptions ?? {}) as Record<string, unknown>;
  const rejection = registryEndpointRejection(options);
  if (rejection) {
    console.warn(`[transit-registry] Dropping ${path}: endpoint rejected (${rejection})`);
    return null;
  }

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
    options,
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

// Populated by setup(ctx) from the resolved integration config cascade.
let githubToken: string | undefined;
export function setGithubToken(value: string | undefined): void {
  githubToken = value && value.length > 0 ? value : undefined;
}

function githubAuthHeaders(url: string): Record<string, string> {
  // Only attach the token to the real GitHub API host. A substring check
  // (url.includes("api.github.com")) would also match e.g.
  // https://api.github.com.evil.com and leak the credential, so compare the
  // parsed hostname exactly.
  let isGithubApiHost = false;
  try {
    isGithubApiHost = new URL(url).hostname === "api.github.com";
  } catch {
    isGithubApiHost = false;
  }
  return githubToken && isGithubApiHost ? { Authorization: `token ${githubToken}` } : {};
}

interface JsDelivrFile {
  type: "file" | "directory";
  name: string;
  files?: JsDelivrFile[];
}

interface JsDelivrFlatFile {
  name: string;
}

/** Collect data JSON paths from JSDelivr responses (tree and flat variants). */
function collectDataPaths(
  node: { files?: Array<JsDelivrFile | JsDelivrFlatFile> },
  prefix = "",
): string[] {
  const paths: string[] = [];
  for (const f of node.files ?? []) {
    const name = f.name.startsWith("/") ? f.name.slice(1) : f.name;
    const path = `${prefix}${name}`;
    if ("type" in f && f.type === "directory") {
      paths.push(...collectDataPaths(f, `${path}/`));
    } else if (path.startsWith("data/") && path.endsWith(".json")) {
      paths.push(path);
    }
  }
  return [...new Set(paths)];
}

/** Fetch file listing via jsDelivr (no auth, no rate limits). */
async function fetchPathsFromJsdelivr(): Promise<string[]> {
  const json = await fetchJson<JsDelivrFile>(TRANSPORT_APIS_JSDELIVR_PKG_URL, {
    timeoutMs: 15_000,
    headers: githubAuthHeaders(TRANSPORT_APIS_JSDELIVR_PKG_URL),
    errorMessage: ({ status }) => `JSDelivr listing: ${status}`,
  });
  return collectDataPaths(json);
}

/** Fetch file listing via GitHub Tree API (requires GITHUB_TOKEN for reliable access). */
async function fetchPathsFromGithub(): Promise<string[]> {
  const tree = await fetchJson<{ tree: GitTreeEntry[] }>(TRANSPORT_APIS_GITHUB_TREE_URL, {
    timeoutMs: 15_000,
    headers: githubAuthHeaders(TRANSPORT_APIS_GITHUB_TREE_URL),
    errorMessage: ({ status }) => `GitHub tree: ${status}`,
  });
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
        const url = `${baseUrl}/${path}`;
        const json = await fetchJson(url, {
          timeoutMs: 10_000,
          headers: githubAuthHeaders(url),
          nullOnError: true,
        });
        return json ? parseEntry(path, json) : null;
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

  // 1. Primary: jsDelivr CDN (no auth, no rate limits, no GitHub API calls)
  try {
    const paths = await fetchPathsFromJsdelivr();
    entries = await fetchInBatchesFrom(paths, TRANSPORT_APIS_JSDELIVR_CDN_BASE);
    console.log(
      `[transit-registry] ${entries.length} entries loaded (JSDelivr @ ${TRANSPORT_APIS_COMMIT.slice(0, 12)})`,
    );
  } catch (err) {
    console.warn("[transit-registry] JSDelivr unavailable, trying GitHub API:", err);
  }

  // 2. Fallback: GitHub Tree API + raw.githubusercontent.com
  if (!entries) {
    try {
      const paths = await fetchPathsFromGithub();
      entries = await fetchInBatchesFrom(paths, TRANSPORT_APIS_RAW_BASE);
      console.log(
        `[transit-registry] ${entries.length} entries loaded (GitHub API @ ${TRANSPORT_APIS_COMMIT.slice(0, 12)})`,
      );
    } catch (err) {
      console.warn("[transit-registry] GitHub API unavailable, trying cache:", err);
    }
  }

  if (entries && entries.length > 0) {
    if (_cache) {
      await _cache.set(REGISTRY_CACHE_KEY, entries, REGISTRY_CACHE_TTL).catch(() => {});
    }
    return entries;
  }

  return loadFromCache();
}

async function loadFromCache(): Promise<RegistryEntry[]> {
  if (!_cache) return [];
  return (await _cache.get<RegistryEntry[]>(REGISTRY_CACHE_KEY)) ?? [];
}

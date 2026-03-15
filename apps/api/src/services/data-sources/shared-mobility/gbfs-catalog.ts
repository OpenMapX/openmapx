/**
 * GBFS catalog — loads the MobilityData systems.csv registry to discover
 * GBFS feeds worldwide. Similar to the transit dynamic registry pattern.
 */

import type { BoundingBox } from "@openmapx/core";
import { withCache } from "../../../utils/cache.js";
import { fetchGbfsSystem } from "./gbfs-client.js";
import type { GbfsCatalogEntry, VehicleFormFactor } from "./types.js";

const CATALOG_URL = "https://raw.githubusercontent.com/MobilityData/gbfs/master/systems.csv";
const CATALOG_CACHE_KEY = "shared-mobility:gbfs-catalog";
const CATALOG_CACHE_TTL = 86_400; // 24h
const SYSTEM_CACHE_TTL = 300; // 5min for system data

let catalogEntries: GbfsCatalogEntry[] | null = null;
let catalogLoadedAt = 0;
const CATALOG_REFRESH_MS = 24 * 60 * 60 * 1000;

// In-memory cache of system bbox approximations (from system_information or station spread)
const systemBboxCache = new Map<
  string,
  { bbox: BoundingBox; vehicleTypes: Set<string>; expiresAt: number }
>();

/**
 * Loads the GBFS systems catalog from MobilityData.
 * Caches in memory and Redis.
 */
export async function loadCatalog(): Promise<GbfsCatalogEntry[]> {
  if (catalogEntries && Date.now() - catalogLoadedAt < CATALOG_REFRESH_MS) {
    return catalogEntries;
  }

  const entries = await withCache<GbfsCatalogEntry[]>(
    CATALOG_CACHE_KEY,
    CATALOG_CACHE_TTL,
    async () => {
      const res = await fetch(CATALOG_URL, {
        headers: { "User-Agent": "OpenMapX/1.0" },
      });
      if (!res.ok) throw new Error(`Failed to fetch GBFS catalog: ${res.status}`);
      const text = await res.text();
      return parseCatalogCsv(text);
    },
  );

  catalogEntries = entries;
  catalogLoadedAt = Date.now();
  return entries;
}

function parseCatalogCsv(csv: string): GbfsCatalogEntry[] {
  const lines = csv.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];

  const entries: GbfsCatalogEntry[] = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]);
    if (fields.length < 6) continue;
    const autoDiscoveryUrl = fields[5]?.trim();
    if (!autoDiscoveryUrl || !autoDiscoveryUrl.startsWith("http")) continue;

    entries.push({
      countryCode: fields[0]?.trim() ?? "",
      name: fields[1]?.trim() ?? "",
      location: fields[2]?.trim() ?? "",
      systemId: fields[3]?.trim() ?? "",
      url: fields[4]?.trim() ?? "",
      autoDiscoveryUrl,
    });
  }
  return entries;
}

/** Simple CSV line parser handling quoted fields. */
function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

/**
 * Geographic lookup helper. Since the GBFS catalog doesn't have coordinates,
 * we need to probe systems to find their coverage.
 *
 * Strategy: We fetch a subset of systems matching the region (by country/city heuristic)
 * and check if their stations fall within the requested bbox.
 */

/** Approximate country bounding boxes for fast pre-filtering. */
const COUNTRY_BBOXES: Record<string, BoundingBox> = {
  US: { south: 24, west: -125, north: 50, east: -66 },
  CA: { south: 41, west: -141, north: 84, east: -52 },
  DE: { south: 47, west: 5.8, north: 55.1, east: 15.1 },
  FR: { south: 41, west: -5.2, north: 51.1, east: 9.6 },
  GB: { south: 49.8, west: -8.2, north: 61, east: 1.8 },
  ES: { south: 36, west: -9.4, north: 43.8, east: 4.3 },
  IT: { south: 35.5, west: 6.6, north: 47.1, east: 18.5 },
  AT: { south: 46.3, west: 9.5, north: 49, east: 17.2 },
  CH: { south: 45.8, west: 5.9, north: 47.8, east: 10.5 },
  BE: { south: 49.5, west: 2.5, north: 51.5, east: 6.4 },
  NL: { south: 50.7, west: 3.3, north: 53.6, east: 7.2 },
  SE: { south: 55.3, west: 11, north: 69.1, east: 24.2 },
  NO: { south: 57.9, west: 4.6, north: 71.2, east: 31.1 },
  FI: { south: 59.8, west: 20.5, north: 70.1, east: 31.6 },
  DK: { south: 54.5, west: 8, north: 57.8, east: 12.7 },
  PL: { south: 49, west: 14.1, north: 54.8, east: 24.2 },
  CZ: { south: 48.5, west: 12.1, north: 51.1, east: 18.9 },
  PT: { south: 36.9, west: -9.5, north: 42.2, east: -6.2 },
  IE: { south: 51.4, west: -10.5, north: 55.4, east: -5.9 },
  AU: { south: -44, west: 113, north: -10, east: 154 },
  NZ: { south: -47.3, west: 166, north: -34.4, east: 178.6 },
  JP: { south: 24, west: 122.9, north: 45.5, east: 145.8 },
  BR: { south: -34, west: -73.9, north: 5.3, east: -34.8 },
  MX: { south: 14.5, west: -118.4, north: 32.7, east: -86.7 },
  IL: { south: 29.5, west: 34.2, north: 33.3, east: 35.9 },
  AE: { south: 22.6, west: 51, north: 26.1, east: 56.4 },
  RO: { south: 43.6, west: 20.3, north: 48.3, east: 29.7 },
  CL: { south: -56, west: -75.6, north: -17.5, east: -66.4 },
};

function bboxOverlaps(a: BoundingBox, b: BoundingBox): boolean {
  return a.south <= b.north && a.north >= b.south && a.west <= b.east && a.east >= b.west;
}

/**
 * Find GBFS catalog entries that might cover the given bbox.
 * Uses country-level pre-filtering to avoid probing every system.
 */
export function filterCatalogByBbox(
  entries: GbfsCatalogEntry[],
  bbox: BoundingBox,
): GbfsCatalogEntry[] {
  // Find countries whose bbox overlaps the query
  const matchingCountries = new Set<string>();
  for (const [cc, countryBbox] of Object.entries(COUNTRY_BBOXES)) {
    if (bboxOverlaps(bbox, countryBbox)) {
      matchingCountries.add(cc);
    }
  }

  // If no known country matches, include all entries (could be a country not in our list)
  if (matchingCountries.size === 0) {
    return entries;
  }

  return entries.filter((e) => matchingCountries.has(e.countryCode));
}

/** Known GBFS operator keywords for scooter/moped systems. */
const SCOOTER_KEYWORDS =
  /\b(tier|voi|lime|bird|bolt|dott|spin|circ|link|zeus|hive|wind|flash|scooter|kick|e-scoot|escoot|superpedestrian|neuron|beam|zipp|gosharing|felyx|moped)\b/i;

function entryMatchesCity(entry: GbfsCatalogEntry, cityLower: string): boolean {
  return (
    entry.systemId.toLowerCase().includes(cityLower) ||
    entry.name.toLowerCase().includes(cityLower) ||
    entry.location.toLowerCase().includes(cityLower)
  );
}

/**
 * Sort catalog entries by relevance to a specific city and form factor.
 * Priority tiers:
 *   3 — city match + scooter keyword (e.g. "bolt_berlin" when searching Berlin)
 *   2 — city match only (e.g. "nextbike_berlin")
 *   1 — scooter keyword only (e.g. "voi_de", nationwide feeds)
 *   0 — neither
 */
export function sortByRelevance(
  entries: GbfsCatalogEntry[],
  city: string | null,
): GbfsCatalogEntry[] {
  const cityLower = city?.toLowerCase() ?? null;

  return [...entries].sort((a, b) => {
    const aCity = cityLower && entryMatchesCity(a, cityLower) ? 2 : 0;
    const bCity = cityLower && entryMatchesCity(b, cityLower) ? 2 : 0;
    const aScooter = SCOOTER_KEYWORDS.test(a.name) || SCOOTER_KEYWORDS.test(a.systemId) ? 1 : 0;
    const bScooter = SCOOTER_KEYWORDS.test(b.name) || SCOOTER_KEYWORDS.test(b.systemId) ? 1 : 0;
    return bCity + bScooter - (aCity + aScooter);
  });
}

/**
 * Probe a GBFS system to determine its geographic coverage and vehicle types.
 * Results are cached in memory.
 */
export async function probeSystem(
  entry: GbfsCatalogEntry,
): Promise<{ bbox: BoundingBox; vehicleTypes: Set<string> } | null> {
  const cached = systemBboxCache.get(entry.systemId);
  if (cached && cached.expiresAt > Date.now()) {
    return { bbox: cached.bbox, vehicleTypes: cached.vehicleTypes };
  }

  const system = await fetchGbfsSystem(entry.autoDiscoveryUrl);
  if (!system) return null;

  // Determine bbox from stations
  let minLat = 90;
  let maxLat = -90;
  let minLon = 180;
  let maxLon = -180;
  let hasCoords = false;

  for (const s of system.stations) {
    if (s.lat && s.lon) {
      minLat = Math.min(minLat, s.lat);
      maxLat = Math.max(maxLat, s.lat);
      minLon = Math.min(minLon, s.lon);
      maxLon = Math.max(maxLon, s.lon);
      hasCoords = true;
    }
  }

  for (const v of system.vehicles) {
    if (v.lat && v.lon) {
      minLat = Math.min(minLat, v.lat);
      maxLat = Math.max(maxLat, v.lat);
      minLon = Math.min(minLon, v.lon);
      maxLon = Math.max(maxLon, v.lon);
      hasCoords = true;
    }
  }

  if (!hasCoords) return null;

  // Add small padding
  const bbox: BoundingBox = {
    south: minLat - 0.01,
    west: minLon - 0.01,
    north: maxLat + 0.01,
    east: maxLon + 0.01,
  };

  // Collect vehicle types
  const vehicleTypes = new Set<string>();
  for (const vt of system.vehicleTypes.values()) {
    vehicleTypes.add(normalizeFormFactor(vt.formFactor));
  }
  // If no vehicle types defined, default to "other" (unknown)
  if (vehicleTypes.size === 0) {
    vehicleTypes.add("other");
  }

  systemBboxCache.set(entry.systemId, {
    bbox,
    vehicleTypes,
    expiresAt: Date.now() + SYSTEM_CACHE_TTL * 1000,
  });

  return { bbox, vehicleTypes };
}

/** Normalize GBFS form_factor to our VehicleFormFactor type. */
export function normalizeFormFactor(gbfsFormFactor: string): VehicleFormFactor {
  switch (gbfsFormFactor) {
    case "bicycle":
      return "bicycle";
    case "cargo_bicycle":
      return "cargo_bicycle";
    case "scooter_standing":
    case "scooter":
      return "scooter_standing";
    case "scooter_seated":
    case "moped":
      return "moped";
    case "car":
      return "car";
    default:
      return "other";
  }
}

export function normalizeGbfsPropulsion(gbfsPropulsion: string): string {
  switch (gbfsPropulsion) {
    case "human":
      return "human";
    case "electric_assist":
      return "electric_assist";
    case "electric":
      return "electric";
    case "combustion":
    case "combustion_diesel":
      return "combustion";
    default:
      return gbfsPropulsion;
  }
}

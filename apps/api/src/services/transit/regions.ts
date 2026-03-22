import { registry } from "./registry/index";
import type { RegistryEntry } from "./registry/types";
import type { BBox } from "./types";

export type RegionalProvider =
  | "tfl"
  | "irail"
  | "mbta"
  | "opendata-ch"
  | "db"
  | "vbb"
  | "bvg"
  | "ris";

interface RegionDef {
  provider: RegionalProvider;
  bbox: BBox;
  envVar?: string;
}

const REGIONS: RegionDef[] = [
  { provider: "tfl", bbox: [-0.51, 51.28, 0.33, 51.69], envVar: "TFL_API_KEY" },
  { provider: "irail", bbox: [2.54, 49.49, 5.92, 51.51] },
  { provider: "mbta", bbox: [-71.9, 41.3, -69.9, 42.9], envVar: "MBTA_API_KEY" },
  { provider: "opendata-ch", bbox: [5.96, 45.82, 10.49, 47.81] },
  // VBB is more specific than DB for Berlin/Brandenburg — listed first so
  // dedup logic can suppress DB when VBB already covers the query bbox.
  { provider: "vbb", bbox: [11.26, 51.36, 14.77, 53.56] },
  // RIS::Routing is the official DB journey planner — preferred over db-vendo-client
  { provider: "ris", bbox: [5.87, 47.27, 15.04, 55.06], envVar: "DB_RIS_CLIENT_ID" },
  { provider: "db", bbox: [5.87, 47.27, 15.04, 55.06] },
];

function bboxesOverlap(a: BBox, b: BBox): boolean {
  return a[2] > b[0] && b[2] > a[0] && a[3] > b[1] && b[3] > a[1];
}

function bboxContains(outer: BBox, inner: BBox): boolean {
  return (
    inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3]
  );
}

// VBB bbox — used for dedup: when the query bbox is fully inside VBB,
// skip DB to avoid duplicate stops.
const VBB_BBOX: BBox = [11.26, 51.36, 14.77, 53.56];

export function getRegionalProviders(bbox: BBox): RegionalProvider[] {
  const providers = REGIONS.filter((r) => {
    if (!bboxesOverlap(bbox, r.bbox)) return false;
    if (r.envVar && !process.env[r.envVar]) return false;
    return true;
  }).map((r) => r.provider);

  // Dedup: if query bbox is entirely within VBB's area, DB would return
  // the same stops — skip it to avoid duplicates.
  if (providers.includes("vbb") && providers.includes("db") && bboxContains(VBB_BBOX, bbox)) {
    return providers.filter((p) => p !== "db");
  }

  return providers;
}

const EARTH_RADIUS = 6_371_000; // meters

export function bboxToCenter(bbox: BBox): { lat: number; lng: number; radiusMeters: number } {
  const [west, south, east, north] = bbox;
  const lat = (south + north) / 2;
  const lng = (west + east) / 2;
  const latDiff = Math.abs(north - south);
  const lngDiff = Math.abs(east - west);
  const latMeters = (latDiff * Math.PI * EARTH_RADIUS) / 180;
  const lngMeters = (lngDiff * Math.PI * EARTH_RADIUS * Math.cos((lat * Math.PI) / 180)) / 180;
  const halfDiag = Math.sqrt(latMeters * latMeters + lngMeters * lngMeters) / 2;
  return { lat, lng, radiusMeters: halfDiag * 1.1 };
}

const PREFIX_MAP: Record<string, RegionalProvider> = {
  "tfl:": "tfl",
  "ir:": "irail",
  "mb:": "mbta",
  "ch:": "opendata-ch",
  "db:": "db",
  "ris:": "ris",
  "vbb:": "vbb",
  "bvg:": "bvg",
};

export function providerFromId(id: string): RegionalProvider | null {
  for (const [prefix, provider] of Object.entries(PREFIX_MAP)) {
    if (id.startsWith(prefix)) return provider;
  }
  return null;
}

/** Find a dynamic registry entry by stop-ID prefix */
export function dynamicEntryFromId(id: string): RegistryEntry | null {
  if (!registry.initialized) return null;
  // Try each known dynamic prefix (format: "slug:restOfId")
  const colonIdx = id.indexOf(":");
  if (colonIdx < 1) return null;
  const prefix = `${id.slice(0, colonIdx)}:`;
  return registry.findByPrefix(prefix);
}

/** Get dynamic registry entries matching a bbox */
export function getDynamicProviders(bbox: BBox): RegistryEntry[] {
  if (!registry.initialized) return [];
  return registry.findProviders(bbox);
}

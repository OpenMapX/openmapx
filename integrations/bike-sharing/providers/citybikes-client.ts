/**
 * CityBikes API client (api.citybik.es/v2).
 * Provides station-based bike sharing data for ~900 networks worldwide.
 */

import { type BoundingBox, bboxContains, type LngLat, USER_AGENT } from "@openmapx/core";
import { TTL, withCache } from "./cache.js";
import type { SharedMobilityStation } from "./types.js";

const CITYBIKES_BASE = "https://api.citybik.es";
const HEADERS = {
  "User-Agent": USER_AGENT,
  Accept: "application/json",
};
const FETCH_TIMEOUT_MS = 10_000;
const NETWORK_INDEX_CACHE_KEY = "shared-mobility:citybikes:networks";

interface CityBikesNetwork {
  id: string;
  name: string;
  href: string;
  company: string[];
  location: {
    latitude: number;
    longitude: number;
    city: string;
    country: string;
  };
}

interface CityBikesStation {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  free_bikes: number;
  empty_slots: number | null;
  timestamp: string;
  extra?: {
    slots?: number;
    ebikes?: number;
    has_ebikes?: boolean;
    payment?: string[];
    uid?: string;
  };
}

interface CityBikesNetworkDetail {
  network: {
    id: string;
    name: string;
    company: string[];
    stations: CityBikesStation[];
  };
}

async function fetchJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const res = await fetch(url, { headers: HEADERS, signal: controller.signal });
  clearTimeout(timer);
  if (!res.ok) throw new Error(`CityBikes API error ${res.status}: ${url}`);
  return res.json() as Promise<T>;
}

/** Cached index of all CityBikes networks. */
async function getNetworkIndex(): Promise<CityBikesNetwork[]> {
  return withCache<CityBikesNetwork[]>(
    NETWORK_INDEX_CACHE_KEY,
    TTL.sharedMobility.networks,
    async () => {
      const data = await fetchJson<{ networks: CityBikesNetwork[] }>(
        `${CITYBIKES_BASE}/v2/networks?fields=id,name,href,company,location`,
      );
      return data.networks;
    },
  );
}

/**
 * Find networks whose location falls within or near the bbox.
 * Uses generous padding (~30km) because a network's center point is just
 * one coordinate while stations can be spread across a metro area.
 */
export async function findNetworksInBbox(bbox: BoundingBox): Promise<CityBikesNetwork[]> {
  const pad = 0.3; // ~30km
  const networks = await getNetworkIndex();
  return networks.filter(
    (n) =>
      n.location.latitude >= bbox.south - pad &&
      n.location.latitude <= bbox.north + pad &&
      n.location.longitude >= bbox.west - pad &&
      n.location.longitude <= bbox.east + pad,
  );
}

/** Fetch station data for a specific network. */
export async function fetchNetworkStations(
  network: CityBikesNetwork,
  bbox: BoundingBox,
): Promise<SharedMobilityStation[]> {
  const cacheKey = `shared-mobility:citybikes:${network.id}`;
  const stations = await withCache<SharedMobilityStation[]>(
    cacheKey,
    TTL.sharedMobility.stations,
    async () => {
      const data = await fetchJson<CityBikesNetworkDetail>(`${CITYBIKES_BASE}${network.href}`);
      const operator = network.company?.[0] ?? network.name;

      return data.network.stations.map(
        (s): SharedMobilityStation => ({
          id: `citybikes/${network.id}/${s.id}`,
          name: s.name,
          coordinates: [s.longitude, s.latitude] as LngLat,
          availableVehicles: s.free_bikes,
          emptySlots: s.empty_slots ?? undefined,
          capacity:
            s.extra?.slots ?? (s.empty_slots != null ? s.free_bikes + s.empty_slots : undefined),
          operator,
          vehicleTypes: ["bicycle"],
          isActive: true,
          sources: [`citybikes/${network.id}`],
        }),
      );
    },
  );

  // Filter to bbox
  return stations.filter((s) => bboxContains(bbox, s.coordinates[1], s.coordinates[0]));
}

/**
 * Search all CityBikes networks within a bounding box.
 * Returns stations from all matching networks.
 */
export async function searchCityBikes(bbox: BoundingBox): Promise<SharedMobilityStation[]> {
  const networks = await findNetworksInBbox(bbox);
  if (networks.length === 0) return [];

  // Limit to max 5 networks per search to avoid excessive API calls
  const limited = networks.slice(0, 5);

  const results = await Promise.allSettled(limited.map((n) => fetchNetworkStations(n, bbox)));

  const stations: SharedMobilityStation[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") {
      stations.push(...r.value);
    }
  }
  return stations;
}

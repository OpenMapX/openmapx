import type { Attribution } from "@openmapx/mobility-core/attribution";
import { snapshotContributors } from "@openmapx/mobility-core/contributors";
/**
 * CityBikes API client (api.citybik.es/v2).
 * Provides station-based bike sharing data for ~900 networks worldwide.
 */

import {
  type BoundingBox,
  bboxContains,
  fetchJson as coreFetchJson,
  type LngLat,
} from "@openmapx/core";
import { type CacheClient, TTL, withCache } from "@openmapx/mobility-core/cache";
import type { SharedMobilityStation } from "@openmapx/mobility-core/shared-mobility";

const CITYBIKES_BASE = "https://api.citybik.es";
const CITYBIKES_ORIGIN = new URL(CITYBIKES_BASE).origin;
const NETWORK_PATH = /^\/v2\/networks\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const HEADERS = {
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
  return coreFetchJson<T>(url, {
    timeoutMs: FETCH_TIMEOUT_MS,
    headers: HEADERS,
    errorMessage: ({ status }) => `CityBikes API error ${status}: ${url}`,
  });
}

/**
 * Resolve a network's `href` from the upstream index to a detail URL. Only a
 * network detail path on the CityBikes origin is accepted; anything else
 * returns null so the network is skipped rather than fetched.
 */
function cityBikesNetworkUrl(href: unknown): URL | null {
  if (typeof href !== "string") return null;
  let url: URL;
  try {
    url = new URL(href, CITYBIKES_BASE);
  } catch {
    return null;
  }
  if (
    url.origin !== CITYBIKES_ORIGIN ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !NETWORK_PATH.test(url.pathname)
  ) {
    return null;
  }
  return url;
}

/** Cached index of all CityBikes networks. */
async function getNetworkIndex(cache: CacheClient): Promise<CityBikesNetwork[]> {
  return withCache<CityBikesNetwork[]>(
    cache,
    NETWORK_INDEX_CACHE_KEY,
    TTL.sharedMobility.networks,
    async () => {
      const data = await fetchJson<{ networks: CityBikesNetwork[] }>(
        `${CITYBIKES_BASE}/v2/networks?fields=id,name,href,company,location`,
      );
      // Drop entries whose detail link leaves the CityBikes API before they are
      // cached, so one bad entry cannot be reused for the whole cache lifetime.
      const skipped: string[] = [];
      const networks = data.networks.filter((network) => {
        const usable = typeof network.id === "string" && cityBikesNetworkUrl(network.href) !== null;
        if (!usable) skipped.push(String(network.id));
        return usable;
      });
      if (skipped.length > 0) {
        console.warn(
          `[citybikes] skipped ${skipped.length} network(s) with an unusable detail link: ${skipped.slice(0, 20).join(", ")}`,
        );
      }
      return networks;
    },
  );
}

/**
 * Find networks whose location falls within or near the bbox.
 * Uses generous padding (~30km) because a network's center point is just
 * one coordinate while stations can be spread across a metro area.
 */
export async function findNetworksInBbox(
  bbox: BoundingBox,
  cache: CacheClient,
): Promise<CityBikesNetwork[]> {
  const pad = 0.3; // ~30km
  const networks = await getNetworkIndex(cache);
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
  cache: CacheClient,
  contributors?: readonly Attribution[],
): Promise<SharedMobilityStation[]> {
  // Checked again here because an index cached before this check existed may
  // still hold entries that were never validated.
  const detailUrl = cityBikesNetworkUrl(network.href);
  if (!detailUrl) {
    console.warn(`[citybikes] skipped network ${String(network.id)}: unusable detail link`);
    return [];
  }
  const cacheKey = `shared-mobility:citybikes:contributors-v1:${network.id}`;
  const stations = await withCache<SharedMobilityStation[]>(
    cache,
    cacheKey,
    TTL.sharedMobility.stations,
    async () => {
      const data = await fetchJson<CityBikesNetworkDetail>(detailUrl.href);
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
          ...(contributors === undefined
            ? {}
            : { contributors: snapshotContributors(contributors) }),
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
export async function searchCityBikes(
  bbox: BoundingBox,
  cache: CacheClient,
  contributors?: readonly Attribution[],
): Promise<SharedMobilityStation[]> {
  const networks = await findNetworksInBbox(bbox, cache);
  if (networks.length === 0) return [];

  // Limit to max 5 networks per search to avoid excessive API calls
  const limited = networks.slice(0, 5);

  const results = await Promise.allSettled(
    limited.map((network) => fetchNetworkStations(network, bbox, cache, contributors)),
  );

  const stations: SharedMobilityStation[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") {
      stations.push(...r.value);
    }
  }
  return stations;
}

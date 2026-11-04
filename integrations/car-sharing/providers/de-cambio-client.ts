import type { Attribution } from "@openmapx/mobility-core/attribution";
import type { CacheClient } from "@openmapx/mobility-core/cache";
import { snapshotContributors } from "@openmapx/mobility-core/contributors";
/**
 * Cambio car-sharing API clients.
 * Station-based car-sharing in Germany and Belgium. The German and Belgian
 * regions are separate clients because they are published under different
 * licences, each credited by its own manifest source.
 * https://github.com/ubahnverleih/WoBike/blob/master/Cambio.md
 */

import { type BoundingBox, bboxContains, fetchJson, type LngLat } from "@openmapx/core";
import type { SharedMobilityStation } from "@openmapx/mobility-core/shared-mobility";
import { type RegionalCarSharingClient, regionMatchesBbox } from "./regional-client-types.js";

const CAMBIO_BASE = "https://cwapi.cambio-carsharing.com/pub";
const FETCH_TIMEOUT_MS = 8_000;
/** Station ids keep this prefix for every region, so existing place ids stay valid. */
const STATION_ID_PREFIX = "de-cambio";

interface CambioRegion {
  code: string;
  name: string;
  lat: number;
  lng: number;
  radiusKm: number;
}

/**
 * Cambio regions, each with a point and a radius that covers all of its stations.
 * A region feed can reach far beyond its city: Köln's holds Bonn and Düsseldorf,
 * Bremen's holds Bremerhaven and Emden, and Flanders' spans Flemish Belgium. The
 * radii add a margin to the farthest station of each feed as of 2026-10-31
 * (Bremen 112 km, Wallonia 121 km, Flanders 126 km, the rest within 37 km).
 * The national lists (`/pub/stations/DEU`, `/pub/stations/BEL`) hold exactly
 * these regions' stations.
 */
const DE_CAMBIO_REGIONS: readonly CambioRegion[] = [
  { code: "AAC", name: "Aachen", lat: 50.776, lng: 6.084, radiusKm: 50 },
  { code: "BRL", name: "Berlin", lat: 52.52, lng: 13.405, radiusKm: 50 },
  { code: "BIL", name: "Bielefeld", lat: 52.03, lng: 8.533, radiusKm: 50 },
  { code: "BRE", name: "Bremen", lat: 53.075, lng: 8.807, radiusKm: 130 },
  { code: "DOR", name: "Dortmund", lat: 51.514, lng: 7.465, radiusKm: 50 },
  { code: "FLB", name: "Flensburg", lat: 54.794, lng: 9.437, radiusKm: 50 },
  { code: "HAM", name: "Hamburg", lat: 53.551, lng: 9.994, radiusKm: 50 },
  { code: "KOE", name: "Köln", lat: 50.938, lng: 6.96, radiusKm: 50 },
  { code: "LBG", name: "Lüneburg", lat: 53.251, lng: 10.414, radiusKm: 50 },
  { code: "OLD", name: "Oldenburg", lat: 53.144, lng: 8.214, radiusKm: 50 },
  { code: "SAB", name: "Saarbrücken", lat: 49.234, lng: 6.997, radiusKm: 50 },
  { code: "WUP", name: "Wuppertal", lat: 51.264, lng: 7.178, radiusKm: 50 },
];

const BE_CAMBIO_REGIONS: readonly CambioRegion[] = [
  { code: "BXL", name: "Brussels", lat: 50.847, lng: 4.356, radiusKm: 50 },
  { code: "WAL", name: "Wallonia", lat: 50.464, lng: 4.87, radiusKm: 140 },
  { code: "VLA", name: "Flanders", lat: 51.054, lng: 3.717, radiusKm: 145 },
];

interface CambioStation {
  id: string | number;
  displayName?: string;
  name: string;
  vehicleCount?: number;
  geoposition?: { longitude: number; latitude: number };
  address?: {
    streetAddress?: string;
    streetNumber?: string;
    addressLocation?: string;
    postalCode?: string;
  };
  vehicleClasses?: { id: string; displayName: string }[];
}

async function fetchRegionStations(
  sourceId: string,
  region: CambioRegion,
  bbox: BoundingBox,
): Promise<SharedMobilityStation[]> {
  try {
    const stations = await fetchJson<CambioStation[]>(`${CAMBIO_BASE}/${region.code}/stations`, {
      timeoutMs: FETCH_TIMEOUT_MS,
    });

    return stations
      .filter(
        (s) =>
          s.geoposition?.latitude &&
          s.geoposition?.longitude &&
          bboxContains(bbox, s.geoposition.latitude, s.geoposition.longitude),
      )
      .map((s): SharedMobilityStation => {
        const geo = s.geoposition as { latitude: number; longitude: number };
        const lat = geo.latitude;
        const lng = geo.longitude;
        const name = s.displayName || s.name;
        return {
          id: `${STATION_ID_PREFIX}/${region.code}/${s.id}`,
          name,
          coordinates: [lng, lat] as LngLat,
          // The API lists the vehicles stationed here, not those free to book now.
          capacity: s.vehicleCount,
          operator: `Cambio ${region.name}`,
          vehicleTypes: ["car"],
          sources: [`${sourceId}/${region.code}`],
        };
      });
  } catch {
    return [];
  }
}

/**
 * A Cambio client for a set of regions. Its id is the manifest source its stations
 * are credited under.
 */
function createCambioClient(
  id: string,
  regions: readonly CambioRegion[],
): RegionalCarSharingClient {
  const matches = (region: CambioRegion, bbox: BoundingBox) =>
    regionMatchesBbox({ center: [region.lng, region.lat], radiusKm: region.radiusKm }, bbox);

  return {
    id,
    name: "Cambio",
    regions: regions.map((r) => ({
      center: [r.lng, r.lat] as LngLat,
      radiusKm: r.radiusKm,
    })),
    async search(
      bbox: BoundingBox,
      _cache?: CacheClient,
      contributors?: readonly Attribution[],
    ): Promise<SharedMobilityStation[]> {
      const inView = regions.filter((region) => matches(region, bbox));
      if (inView.length === 0) return [];

      const results = await Promise.allSettled(
        inView.map((region) => fetchRegionStations(id, region, bbox)),
      );

      const stations: SharedMobilityStation[] = [];
      for (const r of results) {
        if (r.status === "fulfilled") stations.push(...r.value);
      }
      return stations.map((station) =>
        contributors === undefined
          ? station
          : { ...station, contributors: snapshotContributors(contributors) },
      );
    },
  };
}

/** Cambio's German regions, published under DL-DE-ZERO-2.0. */
export const deCambioClient = createCambioClient("de-cambio", DE_CAMBIO_REGIONS);

/** Cambio's Belgian regions, published under CC BY 4.0. */
export const beCambioClient = createCambioClient("be-cambio", BE_CAMBIO_REGIONS);

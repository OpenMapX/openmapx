/**
 * Cambio car-sharing API client.
 * Station-based car-sharing in Germany and Belgium.
 * https://github.com/ubahnverleih/WoBike/blob/master/Cambio.md
 */

import type { BoundingBox, LngLat } from "@openmapx/core";
import { bboxContains } from "@openmapx/core";
import type { SharedMobilityStation } from "@openmapx/integration-shared-mobility/types";
import type { RegionalCarSharingClient } from "./regional-client-types.js";

const CAMBIO_BASE = "https://cwapi.cambio-carsharing.com/pub";
const HEADERS = { "User-Agent": "OpenMapX/1.0 (https://github.com/openmapx)" };
const FETCH_TIMEOUT_MS = 8_000;

/** Cambio regions with approximate center coordinates for bbox matching. */
const CAMBIO_REGIONS: { code: string; name: string; lat: number; lng: number; country: string }[] =
  [
    { code: "AAC", name: "Aachen", lat: 50.776, lng: 6.084, country: "DE" },
    { code: "BRL", name: "Berlin", lat: 52.52, lng: 13.405, country: "DE" },
    { code: "BIL", name: "Bielefeld", lat: 52.03, lng: 8.533, country: "DE" },
    { code: "BRE", name: "Bremen", lat: 53.075, lng: 8.807, country: "DE" },
    { code: "FLB", name: "Flensburg", lat: 54.794, lng: 9.437, country: "DE" },
    { code: "HAM", name: "Hamburg", lat: 53.551, lng: 9.994, country: "DE" },
    { code: "KOE", name: "Köln", lat: 50.938, lng: 6.96, country: "DE" },
    { code: "LBG", name: "Lüneburg", lat: 53.251, lng: 10.414, country: "DE" },
    { code: "OLD", name: "Oldenburg", lat: 53.144, lng: 8.214, country: "DE" },
    { code: "SAB", name: "Saarbrücken", lat: 49.234, lng: 6.997, country: "DE" },
    { code: "WUP", name: "Wuppertal", lat: 51.264, lng: 7.178, country: "DE" },
    { code: "BXL", name: "Brussels", lat: 50.847, lng: 4.356, country: "BE" },
    { code: "WAL", name: "Wallonia", lat: 50.464, lng: 4.87, country: "BE" },
    { code: "VLA", name: "Flanders", lat: 51.054, lng: 3.717, country: "BE" },
  ];

interface CambioStation {
  id: number;
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

/** Find Cambio regions whose center is within ~50km of the bbox. */
function findRegionsInBbox(bbox: BoundingBox): typeof CAMBIO_REGIONS {
  const padding = 0.5; // ~50km
  return CAMBIO_REGIONS.filter(
    (r) =>
      r.lat >= bbox.south - padding &&
      r.lat <= bbox.north + padding &&
      r.lng >= bbox.west - padding &&
      r.lng <= bbox.east + padding,
  );
}

async function fetchRegionStations(
  region: (typeof CAMBIO_REGIONS)[0],
  bbox: BoundingBox,
): Promise<SharedMobilityStation[]> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(`${CAMBIO_BASE}/${region.code}/stations`, {
      headers: HEADERS,
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return [];
    const stations = (await res.json()) as CambioStation[];

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
          id: `cambio/${region.code}/${s.id}`,
          name,
          coordinates: [lng, lat] as LngLat,
          availableVehicles: s.vehicleCount ?? 0,
          operator: `Cambio ${region.name}`,
          vehicleTypes: ["car"],
          isActive: (s.vehicleCount ?? 0) > 0,
          source: `cambio/${region.code}`,
          attribution: {
            label: "Cambio",
            url: "https://www.cambio-carsharing.de",
            license: "ODbL",
            licenseUrl: "https://opendatacommons.org/licenses/odbl/",
          },
        };
      });
  } catch {
    return [];
  }
}

/**
 * Search Cambio stations within a bounding box.
 */
export async function searchCambio(bbox: BoundingBox): Promise<SharedMobilityStation[]> {
  const regions = findRegionsInBbox(bbox);
  if (regions.length === 0) return [];

  const results = await Promise.allSettled(regions.map((r) => fetchRegionStations(r, bbox)));

  const stations: SharedMobilityStation[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") stations.push(...r.value);
  }
  return stations;
}

export const cambioClient: RegionalCarSharingClient = {
  id: "cambio",
  name: "Cambio",
  regions: CAMBIO_REGIONS.map((r) => ({
    center: [r.lng, r.lat] as LngLat,
    radiusKm: 50,
  })),
  attribution: {
    label: "Cambio",
    url: "https://www.cambio-carsharing.de",
    license: "ODbL",
    licenseUrl: "https://opendatacommons.org/licenses/odbl/",
  },
  search: searchCambio,
};

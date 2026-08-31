/**
 * Stadtteilauto Münster car-sharing client.
 * Open data from Stadt Münster: stations + vehicle class metadata.
 * https://ckan.open.nrw.de/dataset/stadtteilauto-munster-carsharing-stationen-und-fahrzeuge-ms
 */

import { type BoundingBox, bboxContains, fetchJson, type LngLat } from "@openmapx/core";
import { type CacheClient, cacheGet, cacheSet, TTL } from "@openmapx/mobility-core/cache";
import type { SharedMobilityStation } from "@openmapx/mobility-core/shared-mobility";
import type { RegionalCarSharingClient } from "./regional-client-types.js";

const STATIONS_URL = "https://www.muenster01.de/stadtteilauto/stations.json";
const VEHICLES_URL = "https://www.muenster01.de/stadtteilauto/vehicles.json";
const FETCH_TIMEOUT_MS = 10_000;
const CACHE_KEY = "cache:de-stadtteilauto:data";

interface DeStadtteilautoStation {
  id: string;
  displayName?: string;
  name?: string;
  address?: {
    streetAddress?: string;
    streetNumber?: string;
    addressLocation?: string;
    postalCode?: string;
    addressCountry?: string;
  };
  geoposition?: {
    longitude: number;
    latitude: number;
    googleZoom?: number;
  };
  information?: {
    access?: string;
    ptLines?: string;
    ptStops?: string;
    location?: string;
    description?: string;
  };
  stationType?: "FIXED" | "FREE";
  vehicleCount?: number;
  vehicleClasses?: { id: string; displayName: string }[];
}

interface DeStadtteilautoVehicle {
  id: string;
  displayName: string;
  availableAtStations?: { id: string; displayName: string }[];
  priceClass?: { id: string; displayName: string };
  equipment?: { id: string; displayName: string }[];
}

const ATTRIBUTION = {
  label: "Stadtteilauto Münster",
  url: "https://opendata.stadt-muenster.de",
  license: "dl-de/by-2-0",
  licenseUrl: "https://www.govdata.de/dl-de/by-2-0",
};

/** Fetch + cache both endpoints, join vehicle metadata to stations. */
async function fetchData(cache: CacheClient): Promise<SharedMobilityStation[]> {
  const cached = await cacheGet<SharedMobilityStation[]>(cache, CACHE_KEY);
  if (cached) return cached;

  try {
    const [rawStations, rawVehicles] = await Promise.all([
      fetchJson<DeStadtteilautoStation[]>(STATIONS_URL, {
        timeoutMs: FETCH_TIMEOUT_MS,
        nullOnError: true,
      }),
      fetchJson<DeStadtteilautoVehicle[]>(VEHICLES_URL, {
        timeoutMs: FETCH_TIMEOUT_MS,
        nullOnError: true,
      }),
    ]);

    if (!rawStations) return [];

    // Build vehicle class enrichment map: displayName → { priceClass, equipment }
    const vehicleEnrichment = new Map<string, { priceClass?: string; equipment?: string[] }>();
    if (rawVehicles) {
      for (const v of rawVehicles) {
        vehicleEnrichment.set(v.displayName, {
          priceClass: v.priceClass?.displayName,
          equipment: v.equipment?.map((e) => e.displayName),
        });
      }
    }

    const stations: SharedMobilityStation[] = [];
    for (const raw of rawStations) {
      if (!raw.geoposition?.latitude || !raw.geoposition?.longitude) continue;

      const name = raw.displayName || raw.name || raw.id;
      const lat = raw.geoposition.latitude;
      const lng = raw.geoposition.longitude;

      // Build vehicle class name list with price class annotation
      const vehicleClassNames: string[] = [];
      if (raw.vehicleClasses) {
        for (const vc of raw.vehicleClasses) {
          const enrichment = vehicleEnrichment.get(vc.displayName);
          const label = enrichment?.priceClass
            ? `${vc.displayName} (${enrichment.priceClass})`
            : vc.displayName;
          vehicleClassNames.push(label);
        }
      }

      stations.push({
        id: `de-stadtteilauto/${raw.id}`,
        name,
        coordinates: [lng, lat] as LngLat,
        availableVehicles: raw.vehicleCount ?? 0,
        operator: "Stadtteilauto Münster",
        vehicleTypes: ["car"],
        isActive: (raw.vehicleCount ?? 0) > 0,
        sources: ["de-stadtteilauto"],
        accessMethod: raw.information?.access,
        transitInfo:
          raw.information?.ptLines || raw.information?.ptStops
            ? { lines: raw.information.ptLines, stops: raw.information.ptStops }
            : undefined,
        locationHint: raw.information?.location,
        operatorNotes: raw.information?.description,
        stationType: raw.stationType ? (raw.stationType === "FREE" ? "free" : "fixed") : undefined,
        vehicleClassNames: vehicleClassNames.length > 0 ? vehicleClassNames : undefined,
        address: raw.address
          ? {
              street: [raw.address.streetAddress, raw.address.streetNumber]
                .filter(Boolean)
                .join(" "),
              city: raw.address.addressLocation,
              postcode: raw.address.postalCode,
              country: raw.address.addressCountry,
            }
          : undefined,
      });
    }

    await cacheSet(cache, CACHE_KEY, stations, TTL.sharedMobility.stations);
    return stations;
  } catch {
    return [];
  }
}

export const deStadtteilautoClient: RegionalCarSharingClient = {
  id: "de-stadtteilauto",
  name: "Stadtteilauto Münster",
  // Münster center, ~20km radius covers all stations
  regions: [{ center: [7.626, 51.962] as LngLat, radiusKm: 20 }],
  attribution: ATTRIBUTION,
  async search(bbox: BoundingBox, cache: CacheClient): Promise<SharedMobilityStation[]> {
    const all = await fetchData(cache);
    return all.filter((s) => bboxContains(bbox, s.coordinates[1], s.coordinates[0]));
  },
};

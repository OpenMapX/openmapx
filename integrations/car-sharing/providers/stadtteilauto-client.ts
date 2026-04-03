/**
 * Stadtteilauto Münster car-sharing client.
 * Open data from Stadt Münster: stations + vehicle class metadata.
 * https://ckan.open.nrw.de/dataset/stadtteilauto-munster-carsharing-stationen-und-fahrzeuge-ms
 */

import type { BoundingBox, LngLat } from "@openmapx/core";
import { bboxContains } from "@openmapx/core";
import { cacheGet, cacheSet, TTL } from "@openmapx/integration-shared-mobility/cache";
import type { SharedMobilityStation } from "@openmapx/integration-shared-mobility/types";
import type { RegionalCarSharingClient } from "./regional-client-types.js";

const STATIONS_URL = "https://www.muenster01.de/stadtteilauto/stations.json";
const VEHICLES_URL = "https://www.muenster01.de/stadtteilauto/vehicles.json";
const FETCH_TIMEOUT_MS = 10_000;
const HEADERS = { "User-Agent": "OpenMapX/1.0 (https://github.com/openmapx)" };
const CACHE_KEY = "cache:stadtteilauto:data";

interface StadtteilAutoStation {
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

interface StadtteilAutoVehicle {
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
async function fetchData(): Promise<SharedMobilityStation[]> {
  const cached = await cacheGet<SharedMobilityStation[]>(CACHE_KEY);
  if (cached) return cached;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const [stationsRes, vehiclesRes] = await Promise.all([
      fetch(STATIONS_URL, { headers: HEADERS, signal: controller.signal }),
      fetch(VEHICLES_URL, { headers: HEADERS, signal: controller.signal }),
    ]);
    clearTimeout(timer);

    if (!stationsRes.ok) {
      vehiclesRes.body?.cancel();
      return [];
    }

    const rawStations = (await stationsRes.json()) as StadtteilAutoStation[];

    // Build vehicle class enrichment map: displayName → { priceClass, equipment }
    const vehicleEnrichment = new Map<string, { priceClass?: string; equipment?: string[] }>();
    if (vehiclesRes.ok) {
      const rawVehicles = (await vehiclesRes.json()) as StadtteilAutoVehicle[];
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
        id: `stadtteilauto/${raw.id}`,
        name,
        coordinates: [lng, lat] as LngLat,
        availableVehicles: raw.vehicleCount ?? 0,
        operator: "Stadtteilauto Münster",
        vehicleTypes: ["car"],
        isActive: (raw.vehicleCount ?? 0) > 0,
        source: "stadtteilauto",
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
        attribution: ATTRIBUTION,
      });
    }

    await cacheSet(CACHE_KEY, stations, TTL.sharedMobility.stations);
    return stations;
  } catch {
    clearTimeout(timer);
    return [];
  }
}

export const stadtteilAutoClient: RegionalCarSharingClient = {
  id: "stadtteilauto",
  name: "Stadtteilauto Münster",
  // Münster center, ~20km radius covers all stations
  regions: [{ center: [7.626, 51.962] as LngLat, radiusKm: 20 }],
  attribution: ATTRIBUTION,
  async search(bbox: BoundingBox): Promise<SharedMobilityStation[]> {
    const all = await fetchData();
    return all.filter((s) => bboxContains(bbox, s.coordinates[1], s.coordinates[0]));
  },
};

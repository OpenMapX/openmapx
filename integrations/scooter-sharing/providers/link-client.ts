/**
 * Link / Superpedestrian e-scooter API client.
 * Covers multiple European cities.
 * https://github.com/ubahnverleih/WoBike/blob/master/Link.md
 */

import { type BoundingBox, fetchJson, type LngLat } from "@openmapx/core";
import type { SharedMobilityVehicle } from "./types.js";

const LINK_URL = "https://vehicles.linkyour.city/reservation-api/local-vehicles/";
const FETCH_TIMEOUT_MS = 8_000;

interface LinkVehicle {
  id: string;
  latitude: number;
  longitude: number;
  battery_level?: number;
  vehicle_type?: string;
}

/**
 * Fetch Link e-scooters near the center of the bbox.
 */
export async function searchLink(bbox: BoundingBox): Promise<SharedMobilityVehicle[]> {
  const centerLat = (bbox.south + bbox.north) / 2;
  const centerLng = (bbox.west + bbox.east) / 2;

  const url = new URL(LINK_URL);
  url.searchParams.set("latitude", String(centerLat));
  url.searchParams.set("longitude", String(centerLng));

  const data = await fetchJson<LinkVehicle[] | { data: LinkVehicle[] }>(url.toString(), {
    timeoutMs: FETCH_TIMEOUT_MS,
    nullOnError: true,
  });
  if (!data) return [];
  const vehicles = Array.isArray(data) ? data : (data.data ?? []);

  return vehicles
    .filter(
      (v) =>
        v.latitude &&
        v.longitude &&
        v.latitude >= bbox.south &&
        v.latitude <= bbox.north &&
        v.longitude >= bbox.west &&
        v.longitude <= bbox.east,
    )
    .map(
      (v): SharedMobilityVehicle => ({
        id: `link/${v.id}`,
        coordinates: [v.longitude, v.latitude] as LngLat,
        formFactor: "scooter_standing",
        propulsion: "electric",
        batteryLevel: v.battery_level != null ? Math.round(v.battery_level) : undefined,
        isReserved: false,
        isDisabled: false,
        operator: "Link",
        sources: ["link"],
      }),
    );
}

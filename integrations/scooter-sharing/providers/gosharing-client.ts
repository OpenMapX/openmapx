/**
 * GO Sharing scooter/moped API client.
 * Covers primarily Netherlands.
 * https://github.com/ubahnverleih/WoBike/blob/master/Go-Sharing.md
 */

import type { BoundingBox, LngLat } from "@openmapx/core";
import type { SharedMobilityVehicle } from "./types.js";

const GOSHARING_URL = "https://greenmo.core.gourban-mobility.com/front/vehicles";
const HEADERS = { "User-Agent": "OpenMapX/1.0 (https://github.com/openmapx)" };
const FETCH_TIMEOUT_MS = 8_000;

interface GoSharingVehicle {
  id: string;
  latitude: number;
  longitude: number;
  battery?: number;
  vehicleType?: string;
}

/**
 * Fetch GO Sharing vehicles near the center of the bbox.
 */
export async function searchGoSharing(bbox: BoundingBox): Promise<SharedMobilityVehicle[]> {
  const centerLat = (bbox.south + bbox.north) / 2;
  const centerLng = (bbox.west + bbox.east) / 2;
  // Approximate radius from bbox diagonal
  const latDiff = bbox.north - bbox.south;
  const lngDiff = bbox.east - bbox.west;
  const radiusKm = Math.sqrt(latDiff ** 2 + lngDiff ** 2) * 55.5; // rough km per degree
  const radiusM = Math.min(Math.round(radiusKm * 1000), 10_000); // cap at 10km

  const url = new URL(GOSHARING_URL);
  url.searchParams.set("lat", String(centerLat));
  url.searchParams.set("lng", String(centerLng));
  url.searchParams.set("rad", String(radiusM));

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(url.toString(), { headers: HEADERS, signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return [];
    const vehicles = (await res.json()) as GoSharingVehicle[];

    return (Array.isArray(vehicles) ? vehicles : [])
      .filter((v) => v.latitude && v.longitude)
      .map(
        (v): SharedMobilityVehicle => ({
          id: `gosharing/${v.id}`,
          coordinates: [v.longitude, v.latitude] as LngLat,
          formFactor: "scooter_standing",
          propulsion: "electric",
          batteryLevel: v.battery != null ? Math.round(v.battery) : undefined,
          isReserved: false,
          isDisabled: false,
          operator: "GO Sharing",
          source: "gosharing",
          attribution: {
            label: "GO Sharing",
            url: "https://go-sharing.com",
            license: "Proprietary",
          },
        }),
      );
  } catch {
    return [];
  }
}

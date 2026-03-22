/**
 * Felyx moped/e-scooter API client (FleetBird platform).
 * Covers Netherlands and Belgium.
 * https://github.com/ubahnverleih/WoBike/blob/master/Felyx.md
 */

import type { BoundingBox, LngLat } from "@openmapx/core";
import { bboxContains } from "../../../utils/geo.js";
import type { SharedMobilityVehicle } from "./types.js";

const FELYX_URL = "https://felyx.frontend.fleetbird.eu/api/prod/v1.06/map/cars/";
const HEADERS = { "User-Agent": "OpenMapX/1.0 (https://github.com/openmapx)" };
const FETCH_TIMEOUT_MS = 8_000;

interface FelyxVehicle {
  id: number;
  lat: number;
  lng: number;
  licencePlate?: string;
  fuelLevel?: number;
  vehicleTypeId?: number;
  isActivated?: boolean;
}

/**
 * Fetch Felyx vehicles within a bounding box.
 */
export async function searchFelyx(bbox: BoundingBox): Promise<SharedMobilityVehicle[]> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(FELYX_URL, { headers: HEADERS, signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return [];
    const vehicles = (await res.json()) as FelyxVehicle[];

    return vehicles
      .filter((v) => v.lat && v.lng && bboxContains(bbox, v.lat, v.lng))
      .map(
        (v): SharedMobilityVehicle => ({
          id: `felyx/${v.id}`,
          coordinates: [v.lng, v.lat] as LngLat,
          formFactor: "moped",
          propulsion: "electric",
          batteryLevel: v.fuelLevel != null ? Math.round(v.fuelLevel) : undefined,
          isReserved: false,
          isDisabled: v.isActivated === false,
          operator: "Felyx",
          source: "felyx",
          attribution: { label: "Felyx", url: "https://felyx.com" },
        }),
      );
  } catch {
    return [];
  }
}

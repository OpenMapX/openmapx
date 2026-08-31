/**
 * Felyx moped/e-scooter API client (FleetBird platform).
 * Covers Netherlands and Belgium.
 * https://github.com/ubahnverleih/WoBike/blob/master/Felyx.md
 */

import { type BoundingBox, bboxContains, fetchJson, type LngLat } from "@openmapx/core";
import type { SharedMobilityVehicle } from "@openmapx/mobility-core/shared-mobility";

const FELYX_URL = "https://felyx.frontend.fleetbird.eu/api/prod/v1.06/map/cars/";
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
    const vehicles = await fetchJson<FelyxVehicle[]>(FELYX_URL, { timeoutMs: FETCH_TIMEOUT_MS });

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
          sources: ["felyx"],
        }),
      );
  } catch {
    return [];
  }
}

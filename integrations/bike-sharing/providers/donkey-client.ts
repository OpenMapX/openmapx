/**
 * Donkey Republic API client.
 * Multi-vehicle hubs (bikes, e-bikes, e-scooters) across European cities.
 * https://github.com/ubahnverleih/WoBike/blob/master/Donkey.md
 */

import { type BoundingBox, fetchJson, type LngLat } from "@openmapx/core";
import type { SharedMobilityStation, VehicleFormFactor } from "./types.js";

const FETCH_TIMEOUT_MS = 8_000;

interface DonkeyHub {
  id: number;
  name: string;
  latitude: number;
  longitude: number;
  available_bikes_count: number;
  available_ebikes_count?: number;
  available_escooters_count?: number;
  available_trailers_count?: number;
  radius?: number;
}

interface DonkeyResponse {
  data: DonkeyHub[];
}

/**
 * Search Donkey Republic hubs within a bounding box.
 */
export async function searchDonkey(bbox: BoundingBox): Promise<SharedMobilityStation[]> {
  const url = new URL("https://stables.donkey.bike/api/public/nearby");
  url.searchParams.set("top_right", `${bbox.north},${bbox.east}`);
  url.searchParams.set("bottom_left", `${bbox.south},${bbox.west}`);
  url.searchParams.set("filter_type", "box");

  const json = await fetchJson<DonkeyResponse>(url.toString(), {
    timeoutMs: FETCH_TIMEOUT_MS,
    headers: { Accept: "application/com.donkeyrepublic.v7" },
    nullOnError: true,
  });
  if (!json) return [];

  return (json.data ?? []).map((hub): SharedMobilityStation => {
    const totalBikes =
      hub.available_bikes_count +
      (hub.available_ebikes_count ?? 0) +
      (hub.available_escooters_count ?? 0) +
      (hub.available_trailers_count ?? 0);

    const vehicleTypes: VehicleFormFactor[] = ["bicycle"];
    if (hub.available_escooters_count && hub.available_escooters_count > 0) {
      vehicleTypes.push("scooter_standing");
    }

    return {
      id: `donkey/${hub.id}`,
      name: hub.name,
      coordinates: [hub.longitude, hub.latitude] as LngLat,
      availableVehicles: totalBikes,
      operator: "Donkey Republic",
      vehicleTypes,
      isActive: totalBikes > 0,
      sources: ["donkey"],
    };
  });
}

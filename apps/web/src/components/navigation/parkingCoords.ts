import type { CategoryPlace, LngLat } from "@openmapx/core";

/** Validate the canonical CategoryPlace coordinate at the UI boundary. */
export function getParkingCoords(place: CategoryPlace): LngLat | null {
  if (Array.isArray(place.coordinates) && place.coordinates.length >= 2) {
    const [lng, lat] = place.coordinates;
    if (
      typeof lng === "number" &&
      typeof lat === "number" &&
      Number.isFinite(lng) &&
      Number.isFinite(lat)
    ) {
      return [lng, lat];
    }
    return null;
  }
  return null;
}

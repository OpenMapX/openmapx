import type { Place } from "../../types/place";

/**
 * Parameters identifying a place to the transit place-board endpoints: the
 * shown name and position, and what links its stops better than a possibly
 * translated name: its OSM object, whose local name the server looks up, and
 * the transit stop it was opened for.
 */
export function placeTransitParams(place: Place): Record<string, string> {
  return {
    lat: String(place.coordinates[1]),
    lng: String(place.coordinates[0]),
    name: place.name,
    place_id: place.id,
    ...(place.ids?.osm ? { osm_id: place.ids.osm } : {}),
    ...(place.transitStop ? { stop_name: place.transitStop.name } : {}),
  };
}

/** Query-key part for a place's board: changes whenever the server would link other stops. */
export function placeTransitKey(place: Place | null): unknown[] {
  return [
    place?.id ?? place?.coordinates?.join(","),
    place?.ids?.osm ?? null,
    place?.transitStop?.name ?? null,
  ];
}

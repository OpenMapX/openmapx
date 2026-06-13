import type { Place } from "@openmapx/core";

/**
 * Visible credit for a place's *core* fields — name, address, opening hours,
 * and raw tags — shown in the place panel footer. Derived from the place
 * itself rather than from the set of installed geocoders, so a place is only
 * ever credited to the source that actually produced it.
 *
 * The core fields of a general place are overwhelmingly OpenStreetMap-based
 * (resolved by the OSM-backed geocoders: Nominatim / Photon / Pelias, and
 * MapTiler which returns OSM refs), and OSM's ODbL requires the credit to be
 * visible wherever the data is shown. Transit-stop places (resolved by the
 * MOTIS/Transitous, Entur, or DB-RIS geocoders, which carry non-`osm` schemes)
 * get their credit from {@link PlaceTransitSection}'s own attribution strip, so
 * this returns "" for them — that's what keeps public-transport credits off
 * non-transit places. The basemap/tile providers (MapTiler, OpenMapTiles) are
 * credited on the map itself via `BaseAttributions`.
 */
export function buildPlaceCoreAttribution(
  place: Pick<Place, "primaryScheme" | "ids" | "osmTags">,
): string {
  const isOsmBacked =
    place.primaryScheme === "osm" ||
    Boolean(place.ids?.osm) ||
    Boolean(place.osmTags && Object.keys(place.osmTags).length > 0);

  if (!isOsmBacked) return "";

  return '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>';
}

/**
 * Catalog + Data API helpers live in `@openmapx/noaa-coops-data` so the
 * `overlay-nautical` station markers and this place-panel tides widget
 * share the same MDAPI cache.
 * Re-exported for callers that imported the legacy paths.
 */
export {
  findNearestStation,
  loadStations,
  type NearestStation,
  type NoaaStation as TideStation,
} from "@openmapx/noaa-coops-data";

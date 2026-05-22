/**
 * Canonical TTL classes for mobility-related data (transit, shared-mobility,
 * parking, fuel, ev-charging). Values are in SECONDS. Use these classes
 * instead of inline literals so cache lifetime decisions are policy, not
 * per-call ad-hocery.
 *
 * Classes describe data-freshness expectations, not API endpoints:
 *
 * - STATIC_ARCHIVE   — feed shapes, route geometry, archival lookups; safe to
 *   cache for a day.
 * - PLACE_LINK       — place ↔ stop linking (very stable once derived).
 * - CATALOG_REFRESH  — periodic catalog / registry pulls (transport-apis,
 *   data-source filters, EV reference lookups); refresh every ~48h.
 * - REFERENCE_DATA   — slowly-changing reference tables (winter-sports
 *   resorts, hiking shelters, EV charging stations search results, etc.);
 *   refresh every ~6h.
 * - SCHEDULE         — published timetables, stops, routes (recompute hourly).
 * - CATEGORY_SEARCH  — POI / category search caches (Overpass etc.); refresh
 *   every ~30 min.
 * - SHORT_LIVED      — per-place derived lookups, trip plans, facility lists
 *   keyed by stop; refresh every ~5 min.
 * - VEHICLE_STATUS   — GBFS station_status, free-floating vehicles (refresh
 *   every ~2 min).
 * - REALTIME_WARM    — alerts, arrivals (refresh ~1 min).
 * - REALTIME_HOT     — live departures, vehicle positions (refresh ~30s).
 */
export const TTL = {
  STATIC_ARCHIVE: 24 * 3600,
  PLACE_LINK: 86_400,
  CATALOG_REFRESH: 48 * 3600,
  REFERENCE_DATA: 6 * 3600,
  SCHEDULE: 3600,
  CATEGORY_SEARCH: 1800,
  SHORT_LIVED: 300,
  VEHICLE_STATUS: 120,
  REALTIME_WARM: 60,
  REALTIME_HOT: 30,
} as const;

/**
 * Canonical dedup thresholds for mobility entities. Distances in METERS;
 * similarity scores are Dice coefficients in [0, 1]; bucket seconds is the
 * time-bucket size used to dedup repeated departures of the same trip.
 */
export const DEDUP = {
  STOP_RADIUS_M: 50,
  STATION_RADIUS_M: 11,
  PARKING_RADIUS_M: 25,
  EV_RADIUS_M: 50,
  NAME_SIMILARITY_MIN: 0.6,
  DEPARTURE_BUCKET_SECONDS: 60,
} as const;

export type TTLClass = keyof typeof TTL;
export type DedupKey = keyof typeof DEDUP;

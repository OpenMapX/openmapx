/**
 * Canonical TTL classes for mobility-related data (transit, shared-mobility,
 * parking, fuel, ev-charging). Values are in SECONDS. Use these classes
 * instead of inline literals so cache lifetime decisions are policy, not
 * per-call ad-hocery.
 *
 * Classes describe data-freshness expectations, not API endpoints:
 *
 * - STATIC_ARCHIVE — feed shapes, route geometry, archival lookups; safe to
 *   cache for a day.
 * - PLACE_LINK     — place ↔ stop linking (very stable once derived).
 * - SCHEDULE       — published timetables, stops, routes (recompute hourly).
 * - VEHICLE_STATUS — GBFS station_status, free-floating vehicles (refresh
 *   every ~2 min).
 * - REALTIME_WARM  — alerts, arrivals (refresh ~1 min).
 * - REALTIME_HOT   — live departures, vehicle positions (refresh ~30s).
 */
export const TTL = {
  STATIC_ARCHIVE: 24 * 3600,
  PLACE_LINK: 86_400,
  SCHEDULE: 3600,
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

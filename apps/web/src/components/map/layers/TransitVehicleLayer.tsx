"use client";

/**
 * Journey stop times describe a timetable/railviz progression, not an observed
 * vehicle location. The old layer interpolated those times and rendered the
 * result as a vehicle marker. Keep the component as a compatibility no-op;
 * true GPS observations belong to the live-transit overlay, which enforces
 * source timestamps and freshness.
 */
export function TransitVehicleLayer() {
  return null;
}

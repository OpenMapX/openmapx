export function getInitials(name: string | null | undefined, email: string): string {
  if (name) {
    return name
      .split(" ")
      .map((n) => n[0])
      .join("")
      .toUpperCase()
      .slice(0, 2);
  }
  return email[0].toUpperCase();
}

import type { UnitSystem } from "../types/geometry.js";

const FEET_PER_METRE = 3.28084;
const FEET_PER_MILE = 5280;
const SQ_FEET_PER_SQ_METRE = 10.7639;
const SQ_FEET_PER_ACRE = 43560;
const SQ_FEET_PER_SQ_MILE = 27_878_400;

/** A distance as guidance shows it: rounded value, unit and decimal places. */
export interface MeasurementDistanceParts {
  value: number;
  unit: "m" | "km" | "ft" | "mi";
  decimals: 0 | 1 | 2;
}

/**
 * The phone's guidance rounding, as number and unit, so other renderers (the Android
 * Auto routing card, the navigation notification) show the same distance without
 * their own rules.
 */
export function measurementDistanceParts(
  metres: number,
  system: UnitSystem = "metric",
): MeasurementDistanceParts {
  const safe = Number.isFinite(metres) ? Math.max(0, metres) : 0;
  if (system === "imperial") {
    const feet = safe * FEET_PER_METRE;
    if (feet < FEET_PER_MILE) return { value: Math.round(feet), unit: "ft", decimals: 0 };
    return { value: Math.round((feet / FEET_PER_MILE) * 100) / 100, unit: "mi", decimals: 2 };
  }
  if (safe < 1000) return { value: Math.round(safe), unit: "m", decimals: 0 };
  // Kilometres carry one decimal while single-digit (5.3 km) but none once
  // double-digit (10 km) — a second decimal is just noise at that scale. The
  // boundary keys on the rounded value so 9.96 km reads "10 km", not "10.0 km".
  const km = safe / 1000;
  const tenths = Math.round(km * 10) / 10;
  return tenths >= 10
    ? { value: Math.round(km), unit: "km", decimals: 0 }
    : { value: tenths, unit: "km", decimals: 1 };
}

export function formatMeasurementDistance(metres: number, system: UnitSystem = "metric"): string {
  const { value, unit, decimals } = measurementDistanceParts(metres, system);
  return `${value.toFixed(decimals)} ${unit}`;
}

export function formatArea(squareMetres: number, system: UnitSystem = "metric"): string {
  if (system === "imperial") {
    const sqFt = squareMetres * SQ_FEET_PER_SQ_METRE;
    if (sqFt < SQ_FEET_PER_ACRE) return `${Math.round(sqFt)} ft\u00B2`;
    if (sqFt < SQ_FEET_PER_SQ_MILE) return `${(sqFt / SQ_FEET_PER_ACRE).toFixed(2)} ac`;
    return `${(sqFt / SQ_FEET_PER_SQ_MILE).toFixed(2)} mi\u00B2`;
  }
  if (squareMetres < 10_000) return `${Math.round(squareMetres)} m\u00B2`;
  if (squareMetres < 1_000_000) return `${(squareMetres / 10_000).toFixed(2)} ha`;
  return `${(squareMetres / 1_000_000).toFixed(2)} km\u00B2`;
}

/**
 * Format a duration in seconds to a human-readable string.
 * < 60 s  → "45 sec"
 * < 3600  → "12 min"
 * ≥ 3600  → "1 h 23 min"
 */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} sec`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

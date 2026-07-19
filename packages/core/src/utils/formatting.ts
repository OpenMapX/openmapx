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

/**
 * Format a distance in metres to a human-readable string.
 * < 1000 m → "850 m"
 * ≥ 1000 m → "1.2 km"
 */
export function formatDistance(metres: number): string {
  if (metres < 1000) return `${Math.round(metres)} m`;
  return `${(metres / 1000).toFixed(1)} km`;
}

import type { UnitSystem } from "../types/geometry.js";

const FEET_PER_METRE = 3.28084;
const FEET_PER_MILE = 5280;
const SQ_FEET_PER_SQ_METRE = 10.7639;
const SQ_FEET_PER_ACRE = 43560;
const SQ_FEET_PER_SQ_MILE = 27_878_400;

export function formatMeasurementDistance(metres: number, system: UnitSystem = "metric"): string {
  if (system === "imperial") {
    const feet = metres * FEET_PER_METRE;
    if (feet < FEET_PER_MILE) return `${Math.round(feet)} ft`;
    return `${(feet / FEET_PER_MILE).toFixed(2)} mi`;
  }
  if (metres < 1000) return `${Math.round(metres)} m`;
  // Kilometres carry one decimal while single-digit (5.3 km) but none once
  // double-digit (10 km) — a second decimal is just noise at that scale. The
  // boundary keys on the rounded value so 9.96 km reads "10 km", not "10.0 km".
  const km = metres / 1000;
  return Math.round(km * 10) / 10 >= 10 ? `${Math.round(km)} km` : `${km.toFixed(1)} km`;
}

/**
 * Format a distance for spoken guidance: coarser, TTS-friendly rounding so the
 * voice says "in 450 metres" / "in 1.2 kilometres" instead of reading out
 * "437 metres" or "1.23 kilometres". Keep {@link formatMeasurementDistance} for
 * the precise on-screen countdown.
 */
export function formatSpokenDistance(metres: number, system: UnitSystem = "metric"): string {
  if (system === "imperial") {
    const feet = metres * FEET_PER_METRE;
    if (feet < 1000) return `${Math.max(50, Math.round(feet / 50) * 50)} ft`;
    return `${(Math.round((feet / FEET_PER_MILE) * 10) / 10).toFixed(1)} mi`;
  }
  if (metres < 100) return `${Math.max(10, Math.round(metres / 10) * 10)} m`;
  if (metres < 1000) return `${Math.round(metres / 50) * 50} m`;
  return `${(Math.round(metres / 100) / 10).toFixed(1)} km`;
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

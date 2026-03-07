import type { LngLat } from "../types/geometry";

/**
 * Attempts to parse user input as decimal-degree coordinates.
 * Supports:
 *   "51.396216, 6.758663"   — lat/lng with comma
 *   "51.396216 6.758663"    — lat/lng with space
 *   "51.396216N 6.758663E"  — with N/S/E/W suffixes
 *   "N51.396216, E6.758663" — with N/S/E/W prefixes
 *   "-33.8688, 151.2093"    — negative values
 */
export function parseCoordinateInput(input: string): { lngLat: LngLat; label: string } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Only coordinate-valid characters allowed
  const remainder = trimmed.replace(/[\d\s,.\-°'"NSEWnsew]/g, "");
  if (remainder.length > 0) return null;

  // Extract all numbers (with optional leading minus)
  const nums = [...trimmed.matchAll(/(-?\d+(?:\.\d+)?)/g)].map((m) => parseFloat(m[1]));
  if (nums.length !== 2) return null;

  let [lat, lng] = nums;
  const upper = trimmed.toUpperCase();
  if (/S/.test(upper)) lat = -Math.abs(lat);
  if (/W/.test(upper)) lng = -Math.abs(lng);

  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;

  return { lngLat: [lng, lat], label: `${lat}, ${lng}` };
}

/**
 * Attempts to parse degrees-minutes-seconds (DMS) coordinates.
 * Supports: "51°23'46.4\"N 6°45'31.9\"E"
 */
export function parseDMSCoordinateInput(input: string): { lngLat: LngLat; label: string } | null {
  const trimmed = input.trim();
  const dmsRegex =
    /^(\d{1,3})\s*°\s*(\d{1,2})\s*['′]\s*(\d{1,2}(?:\.\d+)?)\s*["″]?\s*([NSns])\s*[,\s]+\s*(\d{1,3})\s*°\s*(\d{1,2})\s*['′]\s*(\d{1,2}(?:\.\d+)?)\s*["″]?\s*([EWew])$/;
  const m = trimmed.match(dmsRegex);
  if (!m) return null;

  let lat = parseFloat(m[1]) + parseFloat(m[2]) / 60 + parseFloat(m[3]) / 3600;
  let lng = parseFloat(m[5]) + parseFloat(m[6]) / 60 + parseFloat(m[7]) / 3600;
  if (m[4].toUpperCase() === "S") lat = -lat;
  if (m[8].toUpperCase() === "W") lng = -lng;

  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;

  const fmt = (n: number) => n.toFixed(6).replace(/\.?0+$/, "");
  return { lngLat: [lng, lat], label: `${fmt(lat)}, ${fmt(lng)}` };
}

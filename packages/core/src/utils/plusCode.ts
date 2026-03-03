import type { LngLat } from "../types/geometry";

// Open Location Code (Plus Codes) — open standard by Google, no API key required.
// Spec: https://github.com/google/open-location-code/blob/main/docs/specification.md

const ALPHABET = "23456789CFGHJMPQRVWX";
// Degree resolution for each of the 5 character pairs
const PAIR_RESOLUTIONS = [20.0, 1.0, 0.05, 0.0025, 0.000125];

/**
 * Computes an Open Location Code (Plus Code) from a [longitude, latitude] pair.
 * Returns a standard 10-character full code, e.g. "8FVC9G8F+6X".
 */
export function computePlusCode([lng, lat]: LngLat): string {
  // Clip to valid ranges
  lat = Math.max(-90, Math.min(90, lat));
  lng = Math.max(-180, Math.min(180, lng));

  let latVal = lat + 90;
  let lngVal = lng + 180;

  let code = "";
  for (const res of PAIR_RESOLUTIONS) {
    const latDigit = Math.floor(latVal / res) % 20;
    const lngDigit = Math.floor(lngVal / res) % 20;
    latVal -= latDigit * res;
    lngVal -= lngDigit * res;
    code += ALPHABET[latDigit] + ALPHABET[lngDigit];
  }
  return `${code.slice(0, 8)}+${code.slice(8)}`;
}

/**
 * Returns the short form of a Plus Code by dropping the 4-character area prefix.
 * e.g. "8FVC9G8F+6X" → "9G8F+6X". Append a locality name to make it usable:
 * "9G8F+6X Zurich".
 */
export function shortenPlusCode(fullCode: string): string {
  return fullCode.slice(4);
}

/** Returns the Plus Codes map URL for a given code. */
export function plusCodeUrl(code: string): string {
  return `https://plus.codes/${code}`;
}

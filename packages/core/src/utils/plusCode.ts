import type { LngLat } from "../types/geometry";

// Open Location Code (Plus Codes) — open standard by Google, no API key required.
// Spec: https://github.com/google/open-location-code/blob/main/docs/specification.md

const ALPHABET = "23456789CFGHJMPQRVWX";
// Degree resolution for each of the 5 character pairs
const PAIR_RESOLUTIONS = [20.0, 1.0, 0.05, 0.0025, 0.000125] as const;

// Valid Plus Code characters pattern (for regex character classes)
const PC_CHARS = "23456789CFGHJMPQRVWX";

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
    code += ALPHABET.charAt(latDigit) + ALPHABET.charAt(lngDigit);
  }
  return `${code.slice(0, 8)}+${code.slice(8)}`;
}

/**
 * Returns the short form of a Plus Code by dropping the 4-character area prefix.
 */
export function shortenPlusCode(fullCode: string): string {
  return fullCode.slice(4);
}

/** Returns the Plus Codes map URL for a given code. */
export function plusCodeUrl(code: string): string {
  return `https://plus.codes/${code}`;
}

/**
 * Decodes a full 10-character Plus Code to [longitude, latitude].
 * Returns null if the code is invalid or not a full code.
 */
export function decodePlusCode(code: string): LngLat | null {
  const normalized = code.replace(/\s/g, "").toUpperCase();
  const plusIdx = normalized.indexOf("+");
  if (plusIdx < 0) return null;

  const prefix = normalized.slice(0, plusIdx);
  const suffix = normalized.slice(plusIdx + 1);
  // Full code: exactly 8 prefix chars + at least 2 suffix chars
  if (prefix.length !== 8 || suffix.length < 2) return null;

  const digits = prefix + suffix.slice(0, 2);
  for (const ch of digits) {
    if (!ALPHABET.includes(ch)) return null;
  }

  let latLow = 0;
  let lngLow = 0;
  for (const [i, res] of PAIR_RESOLUTIONS.entries()) {
    latLow += ALPHABET.indexOf(digits.charAt(i * 2)) * res;
    lngLow += ALPHABET.indexOf(digits.charAt(i * 2 + 1)) * res;
  }

  const res = PAIR_RESOLUTIONS[4];
  return [lngLow - 180 + res / 2, latLow - 90 + res / 2];
}

/** Wraps a longitude into [-180, 180). */
function normalizeLongitude(lng: number): number {
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}

/**
 * Expands a short Plus Code to the full code nearest the reference location,
 * following the Open Location Code "recover nearest" rule: prepend the
 * reference's prefix, then move one cell towards the reference when the result
 * is more than half a cell away in latitude or longitude.
 */
function recoverShortPlusCode(shortCode: string, refLat: number, refLng: number): string | null {
  const c = shortCode.replace(/\s/g, "").toUpperCase();
  const plusIdx = c.indexOf("+");
  if (plusIdx < 0) return null;

  const shortPrefix = c.slice(0, plusIdx);
  if (shortPrefix.length !== 4 && shortPrefix.length !== 6) return null;
  const suffix = c.slice(plusIdx + 1);

  const lat = Math.max(-90, Math.min(90, refLat));
  const lng = normalizeLongitude(refLng);
  const paddingLength = 8 - shortPrefix.length; // 4 or 2 characters removed
  const resolution = 20 ** (2 - paddingLength / 2); // 1° or 20° per prefix cell
  const halfResolution = resolution / 2;

  const candidate = `${computePlusCode([lng, lat]).slice(0, paddingLength)}${shortPrefix}+${suffix}`;
  const centre = decodePlusCode(candidate);
  if (!centre) return null;

  let [centreLng, centreLat] = centre;
  if (lat + halfResolution < centreLat && centreLat - resolution >= -90) {
    centreLat -= resolution;
  } else if (lat - halfResolution > centreLat && centreLat + resolution <= 90) {
    centreLat += resolution;
  }
  if (lng + halfResolution < centreLng) {
    centreLng -= resolution;
  } else if (lng - halfResolution > centreLng) {
    centreLng += resolution;
  }
  if (centreLng === centre[0] && centreLat === centre[1]) return candidate;

  // Re-encode the shifted centre and keep the caller's original suffix.
  return `${computePlusCode([normalizeLongitude(centreLng), centreLat]).slice(0, 9)}${suffix}`;
}

/**
 * Detects a short Plus Code with a trailing city/locality name.
 * Returns the code and city name separately so the caller can geocode the city.
 */
export function detectShortPlusCodeCity(input: string): { code: string; city: string } | null {
  const trimmed = input.trim();
  const [, code, city] =
    trimmed.match(new RegExp(`^([${PC_CHARS}]{4,6}\\+[${PC_CHARS}]{2,})[,\\s]+(.+)$`, "i")) ?? [];
  if (code === undefined || city === undefined) return null;
  return { code: code.toUpperCase(), city: city.trim() };
}

/**
 * Decodes a short Plus Code using a known reference location.
 * Use this once the city/locality has been geocoded to coordinates.
 */
export function decodeShortPlusCode(code: string, refLngLat: LngLat): LngLat | null {
  const fullCode = recoverShortPlusCode(code, refLngLat[1], refLngLat[0]);
  if (!fullCode) return null;
  return decodePlusCode(fullCode);
}

/**
 * Attempts to parse user input as a Plus Code and returns the decoded location.
 * Handles full codes and short codes without a city name — the latter uses
 * `refLngLat` (map center) as the area reference.
 * For short codes WITH a city name, use `detectShortPlusCodeCity` + `decodeShortPlusCode`.
 */
export function parsePlusCodeInput(
  input: string,
  refLngLat?: LngLat,
): { lngLat: LngLat; label: string } | null {
  const trimmed = input.trim();
  if (!trimmed.includes("+")) return null;

  const upper = trimmed.toUpperCase();

  // Full code: exactly 8 valid chars + '+' + 2+ valid chars, nothing after
  const fullCode = upper.match(new RegExp(`^([${PC_CHARS}]{8}\\+[${PC_CHARS}]{2,})$`))?.[1];
  if (fullCode !== undefined) {
    const lngLat = decodePlusCode(fullCode);
    if (lngLat) return { lngLat, label: fullCode };
  }

  // Short code without city: 4–6 valid chars + '+' + 2+ valid chars, nothing after
  const shortCode = upper.match(new RegExp(`^([${PC_CHARS}]{4,6}\\+[${PC_CHARS}]{2,})$`))?.[1];
  if (shortCode !== undefined && refLngLat) {
    const lngLat = decodeShortPlusCode(shortCode, refLngLat);
    if (lngLat) return { lngLat, label: shortCode };
  }

  return null;
}

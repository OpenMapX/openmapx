import type { LngLat } from "../types/geometry";

// Open Location Code (Plus Codes) — open standard by Google, no API key required.
// Spec: https://github.com/google/open-location-code/blob/main/docs/specification.md

const ALPHABET = "23456789CFGHJMPQRVWX";
// Degree resolution for each of the 5 character pairs
const PAIR_RESOLUTIONS = [20.0, 1.0, 0.05, 0.0025, 0.000125];

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
    code += ALPHABET[latDigit] + ALPHABET[lngDigit];
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
  for (let i = 0; i < 5; i++) {
    const res = PAIR_RESOLUTIONS[i];
    latLow += ALPHABET.indexOf(digits[i * 2]) * res;
    lngLow += ALPHABET.indexOf(digits[i * 2 + 1]) * res;
  }

  const res = PAIR_RESOLUTIONS[4];
  return [lngLow - 180 + res / 2, latLow - 90 + res / 2];
}

/** Expands a short Plus Code using the reference location's area prefix. */
function recoverShortPlusCode(shortCode: string, refLat: number, refLng: number): string | null {
  const c = shortCode.replace(/\s/g, "").toUpperCase();
  const plusIdx = c.indexOf("+");
  if (plusIdx < 0) return null;

  const shortPrefix = c.slice(0, plusIdx);
  if (shortPrefix.length !== 4 && shortPrefix.length !== 6) return null;

  // Prepend the missing chars from the reference location's full code
  const refCode = computePlusCode([refLng, refLat]);
  const missingChars = 8 - shortPrefix.length;
  return `${refCode.slice(0, missingChars) + shortPrefix}+${c.slice(plusIdx + 1)}`;
}

/**
 * Detects a short Plus Code with a trailing city/locality name.
 * Returns the code and city name separately so the caller can geocode the city.
 */
export function detectShortPlusCodeCity(input: string): { code: string; city: string } | null {
  const trimmed = input.trim();
  const m = trimmed.match(new RegExp(`^([${PC_CHARS}]{4,6}\\+[${PC_CHARS}]{2,})[,\\s]+(.+)$`, "i"));
  if (!m) return null;
  return { code: m[1].toUpperCase(), city: m[2].trim() };
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
  const fullMatch = upper.match(new RegExp(`^([${PC_CHARS}]{8}\\+[${PC_CHARS}]{2,})$`));
  if (fullMatch) {
    const lngLat = decodePlusCode(fullMatch[1]);
    if (lngLat) return { lngLat, label: fullMatch[1] };
  }

  // Short code without city: 4–6 valid chars + '+' + 2+ valid chars, nothing after
  const shortMatch = upper.match(new RegExp(`^([${PC_CHARS}]{4,6}\\+[${PC_CHARS}]{2,})$`));
  if (shortMatch && refLngLat) {
    const lngLat = decodeShortPlusCode(shortMatch[1], refLngLat);
    if (lngLat) return { lngLat, label: shortMatch[1] };
  }

  return null;
}

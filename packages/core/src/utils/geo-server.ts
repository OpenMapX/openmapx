import type { BoundingBox } from "../types/geometry";

const EARTH_RADIUS_M = 6_371_000;

export function bboxContains(bbox: BoundingBox, lat: number, lng: number): boolean {
  return lat >= bbox.south && lat <= bbox.north && lng >= bbox.west && lng <= bbox.east;
}

function bigrams(s: string): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const bg = s.slice(i, i + 2);
    map.set(bg, (map.get(bg) ?? 0) + 1);
  }
  return map;
}

/**
 * Sørensen–Dice coefficient over character bigrams.  Returns 0..1.
 * Two single-character (or empty) strings return 1 if equal, 0 otherwise.
 */
export function diceSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;

  const bg1 = bigrams(a);
  const bg2 = bigrams(b);

  let intersection = 0;
  for (const [bg, count] of bg1) {
    intersection += Math.min(count, bg2.get(bg) ?? 0);
  }

  const total = a.length - 1 + (b.length - 1);
  return (2 * intersection) / total;
}

/**
 * Normalizes a place name for fuzzy matching: strips diacritics (NFKD),
 * lowercases, and collapses any run of non-alphanumeric characters to a single
 * space. So "PENNY"/"Penny" and "Schöneberg"/"Schoneberg" compare as equal and
 * casing/accents/punctuation stop blocking otherwise-identical names.
 */
export function normalizeName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Sørensen–Dice over whitespace-delimited token (word) SETS, 0..1. Complements
 * character-bigram Dice: it rewards shared distinctive words even when word
 * order or surrounding tokens differ ("U Lindauer Allee" vs "U-Bahnhof Lindauer
 * Allee", "Trattoria La Marina" vs "La Marina Trattoria"). Inputs are assumed
 * already normalized.
 */
function tokenDice(a: string, b: string): number {
  const ta = new Set(a.split(" ").filter(Boolean));
  const tb = new Set(b.split(" ").filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersection = 0;
  for (const t of ta) if (tb.has(t)) intersection += 1;
  return (2 * intersection) / (ta.size + tb.size);
}

/**
 * Name similarity for conflation, 0..1. Normalizes both names
 * (case/accent/punctuation insensitive) then returns the max of character-bigram
 * Dice (handles typos/inflections) and word-token Dice (handles word order and
 * prefix/suffix noise). Two names that normalize to the empty string return 0
 * (placeholder/blank names must not match each other).
 */
export function nameSimilarity(a: string, b: string): number {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (na.length === 0 || nb.length === 0) return 0;
  if (na === nb) return 1;
  return Math.max(diceSimilarity(na, nb), tokenDice(na, nb));
}

/** Merge attribution arrays, deduplicating by label. */
export function mergeAttributions<T extends { label: string }>(
  existing: T | T[] | undefined,
  incoming: T | T[] | undefined,
): T | T[] | undefined {
  const toArr = (v: T | T[] | undefined): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
  const existingArr = toArr(existing);
  const incomingArr = toArr(incoming);
  if (incomingArr.length === 0) return existing;
  if (existingArr.length === 0) return incoming;

  const labels = new Set(existingArr.map((a) => a.label));
  const combined = [...existingArr];
  for (const a of incomingArr) {
    if (!labels.has(a.label)) {
      combined.push(a);
      labels.add(a.label);
    }
  }
  return combined.length === 1 ? combined[0] : combined;
}

export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLng = (lng2 - lng1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

/** Great-circle distance between two lat/lng points, in kilometres. */
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  return haversineMeters(lat1, lng1, lat2, lng2) / 1000;
}

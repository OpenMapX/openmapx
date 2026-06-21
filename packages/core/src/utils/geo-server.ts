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
    .replace(/ß/g, "ss")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Normalizes a street name for address-key comparison: applies normalizeName,
 * then folds the German street-type suffixes (straße/strasse → str, platz → pl)
 * so "Karl-Liebknecht-Straße" ≡ "Karl-Liebknecht-Str." AND the compound forms
 * "Schloßstraße" ≡ "Schloßstr." agree. The folds are global, not word-bounded,
 * because most German street types are written compound (one token).
 */
export function normalizeStreet(street: string): string {
  return normalizeName(street)
    .replace(/strasse/g, "str")
    .replace(/platz/g, "pl")
    .trim();
}

function firstHouseNumber(hn: string): string | null {
  const m = hn.match(/\d+/);
  return m ? m[0] : null;
}

/**
 * Address key `postcode|street|housenumber` from separate OSM addr:* tags, or
 * null when any component is missing. Two POIs with the same key are at the same
 * street address — a strong, name-independent same-location signal.
 */
export function osmAddressKey(
  street?: string | null,
  housenumber?: string | null,
  postcode?: string | null,
): string | null {
  if (!street || !housenumber || !postcode) return null;
  const hn = firstHouseNumber(housenumber);
  const st = normalizeStreet(street);
  const pc = postcode.trim();
  return pc && hn && st ? `${pc}|${st}|${hn}` : null;
}

/**
 * Canonicalizes a SINGLE phone number for equality comparison: digits only, with
 * the German country/trunk prefixes folded (+49 / 0049 / leading 0 → subscriber
 * part) so "+49 30 318 06 750" and "030 31806750" compare equal. The "49"
 * country code is stripped only when the input carried an explicit international
 * prefix (`+` or `00`) — a bare local number that merely starts with 49 keeps
 * all its digits. Returns null for numbers too short to be a reliable signal.
 * For tag values that may hold multiple numbers, use parsePhones.
 */
export function normalizePhone(phone?: string | null): string | null {
  if (!phone) return null;
  const hadIntlPrefix = /^\s*(?:\+|00)/.test(phone);
  let d = phone.replace(/\D/g, "");
  if (d.startsWith("0049")) d = d.slice(4);
  else if (hadIntlPrefix && d.startsWith("49")) d = d.slice(2);
  if (d.startsWith("0")) d = d.slice(1);
  return d.length >= 6 ? d : null;
}

/**
 * Canonicalizes a phone field that may hold multiple numbers — an Overture
 * `phones[]` array, or an OSM tag using the documented `;`/`,`-separated
 * multi-value convention ("+49 30 1;+49 30 2") — into a deduped set of
 * canonical numbers. Two POIs are the same business when their phone sets
 * INTERSECT and different businesses when both are non-empty yet disjoint, so a
 * single stale or secondary number on one side never forces a false split.
 */
export function parsePhones(value?: string | string[] | null): string[] {
  if (value == null) return [];
  const parts = Array.isArray(value) ? value : value.split(/[;,/]/);
  const out = new Set<string>();
  for (const part of parts) {
    const n = normalizePhone(part);
    if (n) out.add(n);
  }
  return [...out];
}

/**
 * Extracts the bare host (no scheme, no `www.`, no userinfo, no port, lowercased)
 * from a URL — a brand/site-level signal: an equal domain within the window
 * corroborates a match. Uses the URL parser (so credentials, ports and IDNs are
 * handled consistently) and tolerates scheme-less ("edeka.de/markt") and
 * protocol-relative ("//edeka.de") inputs. Returns null when no host parses.
 */
export function websiteDomain(url?: string | null): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed.replace(/^\/\//, "")}`;
  try {
    const host = new URL(withScheme).hostname.replace(/^www\./, "").toLowerCase();
    return host || null;
  } catch {
    return null;
  }
}

/**
 * Address key from an Overture freeform address (`"<street> <housenumber>"`) +
 * postcode, in the same `postcode|street|housenumber` shape as osmAddressKey.
 */
export function overtureAddressKey(
  freeform?: string | null,
  postcode?: string | null,
): string | null {
  if (!freeform || !postcode) return null;
  // Split "<street> <housenumber>" on the LAST whitespace/comma via a linear
  // scan rather than a regex — the freeform comes from library data, and a
  // backtracking pattern here is a polynomial-ReDoS vector.
  const trimmed = freeform.trim();
  const sepIdx = Math.max(
    trimmed.lastIndexOf(" "),
    trimmed.lastIndexOf(","),
    trimmed.lastIndexOf("\t"),
  );
  if (sepIdx <= 0) return null;
  const hnPart = trimmed.slice(sepIdx + 1);
  if (!/^\d/.test(hnPart)) return null; // house number must start with a digit
  const st = normalizeStreet(trimmed.slice(0, sepIdx));
  const hn = firstHouseNumber(hnPart);
  const pc = postcode.trim();
  return st && hn && pc ? `${pc}|${st}|${hn}` : null;
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

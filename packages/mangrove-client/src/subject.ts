/**
 * Mangrove geo-URI subject builder — shared by client and server so the
 * cache key, sign payload and read query all target the exact same bucket.
 *
 * Spec: `geo:LAT,LON?q=NAME&u=UNCERTAINTY_METERS` (Android-style `?`).
 * We pin 6-decimal precision and `u=30` for deterministic bucketing.
 */

export const DEFAULT_UNCERTAINTY_METERS = 30;

/**
 * Maximum distance (meters) between a queried place and a returned review's
 * own pin to consider the review "about the same place". Tolerates GPS jitter
 * and disagreement between geocoders without bleeding into neighbouring
 * businesses on a typical city block.
 */
export const REVIEW_MATCH_MAX_DISTANCE_METERS = 80;

/**
 * Fallback cap for third-party / older-format reviews that have a `geo:`
 * subject but no usable name (`q=`) or OSM metadata. Such records are ambiguous
 * in dense POI clusters, so only attach them when the pin is effectively on
 * top of the selected place.
 */
export const REVIEW_NAMELESS_MATCH_MAX_DISTANCE_METERS = 15;

/**
 * Uncertainty (meters) used for read queries. Larger than the submit value so
 * the upstream spatial filter (`stored_u + query_u`) returns reviews submitted
 * with sloppy GPS, then we tighten with our own post-filter.
 */
export const QUERY_UNCERTAINTY_METERS = 100;

/**
 * Experience-context chip values used by the official Mangrove UI for `geo:`
 * place subjects. Keeping our options aligned with the upstream UI means our
 * reviews aggregate cleanly with reviews submitted from mangrove.reviews and
 * other clients that follow the same convention.
 *
 * Note: mangrove.reviews uses DIFFERENT option sets for https://, urn:isbn:,
 * urn:lei: and urn:maresi: subjects — if OpenMapX ever reviews non-places it
 * should mirror those scheme-specific lists instead.
 */
export const EXPERIENCE_CONTEXT_GEO = [
  "business",
  "family",
  "couple/date",
  "sightseeing",
  "friends",
] as const;

export type GeoExperienceContext = (typeof EXPERIENCE_CONTEXT_GEO)[number];

export interface MangroveSubject {
  lat: number;
  lng: number;
  name: string;
  uncertainty?: number;
}

export function buildMangroveSubjectUri(s: MangroveSubject): string {
  const lat = s.lat.toFixed(6);
  const lng = s.lng.toFixed(6);
  const q = encodeURIComponent(s.name.trim());
  const u = Math.max(
    1,
    Math.min(40_000_000, Math.round(s.uncertainty ?? DEFAULT_UNCERTAINTY_METERS)),
  );
  return `geo:${lat},${lng}?q=${q}&u=${u}`;
}

/**
 * Build a Mangrove subject URI for READ queries — same coordinates, but
 * deliberately omits `q=NAME`.
 *
 * Why: Mangrove's `/reviews?sub=geo:...` server-side filter is
 * `is_spatially_close OR sub ILIKE '%q=NAME%'`. Including `q=` makes the
 * server return any review with a matching name *anywhere in the world*
 * (every "McDonald's" globally), then drowning the response so spatially-
 * close reviews can fall outside the `limit=200` window.
 *
 * Without `q=`, the filter degrades to pure spatial — bounded by
 * `stored_u + query_u`. We still post-filter locally with our own tighter
 * radius to be robust against reviews submitted with very large `u`.
 */
export function buildMangroveQueryUri(s: {
  lat: number;
  lng: number;
  uncertainty?: number;
}): string {
  const lat = s.lat.toFixed(6);
  const lng = s.lng.toFixed(6);
  const u = Math.max(
    1,
    Math.min(40_000_000, Math.round(s.uncertainty ?? QUERY_UNCERTAINTY_METERS)),
  );
  return `geo:${lat},${lng}?u=${u}`;
}

export interface ParsedMangroveGeoUri {
  lat: number;
  lng: number;
  name?: string;
  uncertainty?: number;
}

/**
 * Parse a `geo:LAT,LON?q=NAME&u=U` (Android-style) or `geo:LAT,LON;q=NAME;u=U`
 * (RFC 5870) URI into its components. Returns null if the URI isn't a usable
 * `geo:` reference.
 */
export function parseMangroveGeoUri(uri: string): ParsedMangroveGeoUri | null {
  if (typeof uri !== "string" || !uri.startsWith("geo:")) return null;
  const rest = uri.slice(4);
  const qIdx = rest.indexOf("?");
  const sIdx = rest.indexOf(";");
  const sepIdx = qIdx === -1 ? sIdx : sIdx === -1 ? qIdx : Math.min(qIdx, sIdx);
  const coordStr = sepIdx === -1 ? rest : rest.slice(0, sepIdx);
  const paramStr = sepIdx === -1 ? "" : rest.slice(sepIdx + 1);

  const parts = coordStr.split(",");
  if (parts.length < 2) return null;
  const lat = Number(parts[0]);
  const lng = Number(parts[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  let name: string | undefined;
  let uncertainty: number | undefined;
  if (paramStr) {
    // Both `?` and `;` separators use the same `key=value&key=value` shape in
    // practice; URLSearchParams handles `&` so we normalize `;` first.
    const normalized = paramStr.replace(/;/g, "&");
    const params = new URLSearchParams(normalized);
    const q = params.get("q");
    if (q) name = q;
    const u = params.get("u");
    if (u) {
      const n = Number(u);
      if (Number.isFinite(n) && n >= 0) uncertainty = n;
    }
  }
  return { lat, lng, name, uncertainty };
}

/**
 * Normalize Mangrove/OSM metadata references to `node|way|relation/id`.
 *
 * Mangrove imports commonly store `metadata.osm_id` as `node/123`, while OSM
 * references may optionally include a version suffix. For review linking, the
 * element identity matters; the historical version does not.
 */
export function normalizeOsmElementRef(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = value.trim().toLowerCase().replace(/^osm:/, "");
  const match = cleaned.match(/^(node|way|relation)\/(\d+)(?:\/\d+)?$/);
  if (!match) return undefined;
  return `${match[1]}/${match[2]}`;
}

/**
 * Normalize a human-facing place name for conservative equality checks. This
 * is intentionally not fuzzy matching: nearby restaurants, cafes and shops can
 * share tokens, so substring matching would reintroduce review bleed.
 */
export function normalizeMangrovePlaceName(value: string | undefined): string | undefined {
  const normalized = value
    ?.normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  return normalized || undefined;
}

/** Great-circle distance between two lat/lng points, in meters. */
export function haversineDistanceMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const x = Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
}

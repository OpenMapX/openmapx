/**
 * Mangrove geo-URI subject builder — shared by client and server so the
 * cache key, sign payload and read query all target the exact same bucket.
 *
 * Spec: `geo:LAT,LON?q=NAME&u=UNCERTAINTY_METERS` (Android-style `?`).
 * We pin 6-decimal precision and `u=30` for deterministic bucketing.
 */

export const DEFAULT_UNCERTAINTY_METERS = 30;

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

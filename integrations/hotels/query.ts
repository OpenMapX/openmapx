// integrations/hotels/query.ts
import type { HotelQuery } from "./types.js";

const MAX_LEN = 120;
const CC_RE = /^[A-Za-z]{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type ParseResult = { ok: true; query: HotelQuery } | { ok: false; error: string };

function parseCoord(raw: string | undefined, min: number, max: number): number | undefined {
  const n = Number.parseFloat(raw ?? "");
  if (!Number.isFinite(n) || n < min || n > max) return undefined;
  return n;
}

/** Parse a positive integer, clamped to [min, max]; undefined if absent/invalid. */
function parseCount(raw: string | undefined, min: number, max: number): number | undefined {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isInteger(n) || n < min) return undefined;
  return Math.min(max, n);
}

function parseDate(raw: string | undefined): string | undefined {
  const v = (raw ?? "").trim();
  if (!DATE_RE.test(v)) return undefined;
  // Reject format-valid but impossible dates (2026-13-99, 2026-02-31) by round-tripping.
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? undefined : v;
}

/**
 * Validate and normalise the raw query string of `/:provider/open` (and `/url`,
 * `/offers`) into a HotelQuery. `name` is required; the rest are optional
 * refinements that scope the search to the hotel's location, dates, occupancy.
 */
export function parseHotelQuery(q: Record<string, string>): ParseResult {
  const name = (q.name ?? "").trim().slice(0, MAX_LEN);
  if (!name) return { ok: false, error: "'name' is required" };
  const city = (q.city ?? "").trim().slice(0, MAX_LEN) || undefined;
  const countryRaw = (q.country ?? "").trim();
  const countryCode = CC_RE.test(countryRaw) ? countryRaw.toLowerCase() : undefined;
  const lat = parseCoord(q.lat, -90, 90);
  const lng = parseCoord(q.lng, -180, 180);
  const address = (q.address ?? "").trim().slice(0, 200) || undefined;
  const checkIn = parseDate(q.checkIn);
  const checkOut = parseDate(q.checkOut);
  const adults = parseCount(q.adults, 1, 16);
  const rooms = parseCount(q.rooms, 1, 8);
  const wikidataRaw = (q.wikidata ?? "").trim();
  const wikidata = /^Q\d+$/.test(wikidataRaw) ? wikidataRaw : undefined;
  return {
    ok: true,
    query: {
      name,
      city,
      countryCode,
      lat,
      lng,
      address,
      checkIn,
      checkOut,
      adults,
      rooms,
      wikidata,
    },
  };
}

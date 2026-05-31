import type { DeliveryQuery } from "./types.js";

const MAX_LEN = 120;
const CC_RE = /^[A-Za-z]{2}$/;

export type ParseResult = { ok: true; query: DeliveryQuery } | { ok: false; error: string };

function parseCoord(raw: string | undefined, min: number, max: number): number | undefined {
  const n = Number.parseFloat(raw ?? "");
  if (!Number.isFinite(n) || n < min || n > max) return undefined;
  return n;
}

/**
 * Validate and normalise the raw query string of `/:provider/open` (and
 * `/url`) into a {@link DeliveryQuery}. `name` is required; the rest are
 * optional refinements that let providers scope the search to the restaurant's
 * actual location.
 */
export function parseDeliveryQuery(q: Record<string, string>): ParseResult {
  const name = (q.name ?? "").trim().slice(0, MAX_LEN);
  if (!name) {
    return { ok: false, error: "'name' is required" };
  }
  const city = (q.city ?? "").trim().slice(0, MAX_LEN) || undefined;
  const countryRaw = (q.country ?? "").trim();
  const countryCode = CC_RE.test(countryRaw) ? countryRaw.toLowerCase() : undefined;
  const lat = parseCoord(q.lat, -90, 90);
  const lng = parseCoord(q.lng, -180, 180);
  const postcode = (q.postcode ?? "").trim().slice(0, 16) || undefined;
  const address = (q.address ?? "").trim().slice(0, 200) || undefined;
  return { ok: true, query: { name, city, countryCode, lat, lng, postcode, address } };
}

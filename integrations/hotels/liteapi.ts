/**
 * LiteAPI v3.0 rates client + offer normalizer.
 *
 * Request/response field paths were VERIFIED against the live LiteAPI sandbox
 * on 2026-05-31: `/data/hotels` returns flat `data[].id/name/latitude/longitude`
 * (radius in metres), and `/hotels/rates` returns
 * `data[].roomTypes[].rates[].retailRate.{total,suggestedSellingPrice}[0].amount`
 * with `cancellationPolicies.refundableTag` (`RFN`/`NRFN`). The unit tests pin
 * this shape. Note: the matched hotel must have availability for the dates — if
 * it doesn't, `searchOffer` correctly returns null (we never show a neighbour's
 * price), which is common in the sparse sandbox but rare in production.
 */
import { fetchJson } from "@openmapx/core";
import { type HotelOffer, haversineKm } from "@openmapx/core/server";
import { nameMatches, normalizeName } from "./match.js";
import type { HotelQuery } from "./types.js";

const LITEAPI_BASE = "https://api.liteapi.travel/v3.0";
const TIMEOUT_MS = 6000;
/** Radius (metres) for the nearby-hotel candidate lookup. */
const SEARCH_RADIUS_M = 1000;
/** An unnamed candidate must be within this many km to be accepted. */
const MAX_UNNAMED_MATCH_KM = 0.3;
/** A name-matched candidate is trusted only within this many km: the queried
 *  hotel sits at the query's own coordinates, so the true match is normally
 *  <100m; a same-named candidate farther out (a different branch / a generic
 *  brand-name neighbour) is rejected so we never price the wrong property. */
const MAX_NAMED_MATCH_KM = 0.6;

interface LiteRate {
  retailRate?: {
    total?: Array<{ amount?: number; currency?: string }>;
    suggestedSellingPrice?: Array<{ amount?: number; currency?: string }>;
  };
  cancellationPolicies?: { refundableTag?: string };
}
interface LiteRatesResponse {
  data?: Array<{ hotelId?: string; roomTypes?: Array<{ rates?: LiteRate[] }> }>;
}

/** A nearby hotel candidate from GET /data/hotels (normalised by this module). */
export interface LiteHotelCandidate {
  id: string;
  name: string;
  lat: number;
  lng: number;
}

/**
 * Distribute `adults` total guests across `rooms` rooms (one LiteAPI
 * `occupancies` entry per room, ≥1 adult each). Our UI models `adults` as the
 * total guest count (like Booking.com's `group_adults`), so we split it rather
 * than repeating it per room.
 */
export function buildOccupancies(
  adults: number,
  rooms: number,
): Array<{ adults: number; children: number[] }> {
  const total = Math.max(1, adults);
  // Never create more occupied rooms than guests: LiteAPI requires ≥1 adult per
  // occupancy, so when the user picks more rooms than adults we cap the room
  // count rather than inventing extra guests (which would over-price the stay).
  const r = Math.max(1, Math.min(rooms, total));
  const base = Math.floor(total / r);
  const extra = total % r;
  return Array.from({ length: r }, (_, i) => ({
    adults: base + (i < extra ? 1 : 0),
    children: [],
  }));
}

/** Number of nights between two `YYYY-MM-DD` dates (min 1; never NaN/0). */
export function nights(checkIn?: string, checkOut?: string): number {
  if (!checkIn || !checkOut) return 1;
  const a = Date.parse(checkIn);
  const b = Date.parse(checkOut);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 1;
  return Math.max(1, Math.round((b - a) / 86_400_000));
}

/**
 * Choose the candidate hotel that best matches the queried place, so the price
 * we show belongs to THIS hotel and not a cheaper neighbour. Prefers a name
 * token overlap; among name matches (or, with no name match, among all
 * candidates) picks the nearest by coordinate. An unnamed nearest match beyond
 * {@link MAX_UNNAMED_MATCH_KM} is rejected (returns null → caller falls back to
 * the Tier-1 deep links). Pure + unit-testable.
 */
export function pickBestHotel(
  candidates: LiteHotelCandidate[],
  q: HotelQuery,
): LiteHotelCandidate | null {
  if (candidates.length === 0) return null;
  const dist = (c: LiteHotelCandidate) =>
    typeof q.lat === "number" && typeof q.lng === "number"
      ? haversineKm(q.lat, q.lng, c.lat, c.lng)
      : Number.POSITIVE_INFINITY;
  // Same name-match rule as the typeahead resolver (see match.ts) so the live
  // price and the deep link agree on which hotel this is.
  const named = normalizeName(q.name) ? candidates.filter((c) => nameMatches(q.name, c.name)) : [];
  const pool = named.length > 0 ? named : candidates;
  const best = [...pool].sort((a, b) => dist(a) - dist(b))[0];
  if (!best) return null;
  const bestKm = dist(best);
  if (named.length > 0) {
    // A name match is trusted only within MAX_NAMED_MATCH_KM (when measurable);
    // beyond that, even a same-named candidate is more likely a different
    // property than the one at the query's own coordinates.
    if (Number.isFinite(bestKm) && bestKm > MAX_NAMED_MATCH_KM) return null;
  } else if (bestKm > MAX_UNNAMED_MATCH_KM) {
    // Unnamed picks must be essentially the same address (no-coords → rejected).
    return null;
  }
  return best;
}

/**
 * Reduce one hotel's LiteAPI rates response to its single lowest offer. Pure
 * (no network) so it is unit-testable. `stayNights` divides the total into a
 * nightly-from figure.
 */
export function normalizeRatesResponse(
  resp: LiteRatesResponse,
  stayNights: number,
): HotelOffer | null {
  let bestTotal = Number.POSITIVE_INFINITY;
  let bestCurrency = "";
  let bestSSP: number | undefined;
  let anyRefundable = false;
  for (const hotel of resp.data ?? []) {
    for (const rt of hotel.roomTypes ?? []) {
      for (const rate of rt.rates ?? []) {
        const total = rate.retailRate?.total?.[0]?.amount;
        const currency = rate.retailRate?.total?.[0]?.currency;
        if (typeof total !== "number" || !currency) continue;
        if (rate.cancellationPolicies?.refundableTag === "RFN") anyRefundable = true;
        if (total < bestTotal) {
          bestTotal = total;
          bestCurrency = currency;
          bestSSP = rate.retailRate?.suggestedSellingPrice?.[0]?.amount;
        }
      }
    }
  }
  if (!Number.isFinite(bestTotal)) return null;
  return {
    source: "liteapi",
    total: bestTotal,
    nightlyFrom: Math.round(bestTotal / Math.max(1, stayNights)),
    currency: bestCurrency,
    suggestedSellingPrice: bestSSP,
    refundable: anyRefundable,
  };
}

/** GET /data/hotels near the place → normalised candidates. */
async function fetchNearbyHotels(apiKey: string, q: HotelQuery): Promise<LiteHotelCandidate[]> {
  const params = new URLSearchParams({
    latitude: String(q.lat),
    longitude: String(q.lng),
    radius: String(SEARCH_RADIUS_M),
    limit: "30",
  });
  // Verified against the live sandbox (2026-05-31): candidates carry flat
  // `latitude`/`longitude` (not a nested `geoCode`).
  const json = await fetchJson<{
    data?: Array<{ id?: string; name?: string; latitude?: number; longitude?: number }>;
  }>(`${LITEAPI_BASE}/data/hotels?${params.toString()}`, {
    timeoutMs: TIMEOUT_MS,
    headers: { "X-API-Key": apiKey },
    nullOnError: true,
  });
  if (!json) return [];
  return (json.data ?? [])
    .filter(
      (h): h is { id: string; name: string; latitude: number; longitude: number } =>
        typeof h.id === "string" &&
        typeof h.name === "string" &&
        typeof h.latitude === "number" &&
        typeof h.longitude === "number",
    )
    .map((h) => ({ id: h.id, name: h.name, lat: h.latitude, lng: h.longitude }));
}

/** Currency + guest nationality for a rate request (user-chosen in the UI). */
export interface RateOptions {
  /** ISO-4217 currency, e.g. "EUR". */
  currency: string;
  /** ISO-3166-1 alpha-2 guest nationality (uppercase), e.g. "DE". */
  guestNationality: string;
}

/** POST /hotels/rates for a single resolved hotel. */
async function fetchRatesForHotel(
  apiKey: string,
  opts: RateOptions,
  hotelId: string,
  q: HotelQuery,
): Promise<LiteRatesResponse> {
  const json = await fetchJson<LiteRatesResponse>(`${LITEAPI_BASE}/hotels/rates`, {
    timeoutMs: TIMEOUT_MS,
    headers: { "content-type": "application/json", "X-API-Key": apiKey },
    nullOnError: true,
    init: {
      method: "POST",
      body: JSON.stringify({
        hotelIds: [hotelId],
        checkin: q.checkIn,
        checkout: q.checkOut,
        currency: opts.currency,
        guestNationality: opts.guestNationality.toUpperCase(),
        occupancies: buildOccupancies(q.adults ?? 2, q.rooms ?? 1),
      }),
    },
  });
  return json ?? { data: [] };
}

/**
 * Fetch the lowest live nightly rate for THIS hotel: resolve the matching
 * nearby hotel id, then price just that one. Returns null on any failure
 * (missing coords/dates, no match, network/upstream error) so the caller falls
 * back to the deep-link experience silently. Two cached server-side calls to a fixed host.
 */
export async function fetchLiteApiOffer(
  apiKey: string,
  opts: RateOptions,
  q: HotelQuery,
): Promise<HotelOffer | null> {
  if (typeof q.lat !== "number" || typeof q.lng !== "number") return null;
  if (!q.checkIn || !q.checkOut) return null;
  try {
    const hotel = pickBestHotel(await fetchNearbyHotels(apiKey, q), q);
    if (!hotel) return null;
    const rates = await fetchRatesForHotel(apiKey, opts, hotel.id, q);
    return normalizeRatesResponse(rates, nights(q.checkIn, q.checkOut));
  } catch {
    return null;
  }
}

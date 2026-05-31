/**
 * LiteAPI v3.0 rates client + offer normalizer.
 *
 * IMPORTANT: LiteAPI request/response field paths are per the docs and
 * UNVERIFIED against a live sandbox — validate against a real `sand_` response
 * before enabling Tier 2 in production. The unit tests pin the documented
 * shape; until Step 0 of Task B1 is executed with a real key, treat the field
 * paths as best-effort.
 */
import { type HotelOffer, haversineKm } from "@openmapx/core/server";
import type { HotelQuery } from "./types.js";

const LITEAPI_BASE = "https://api.liteapi.travel/v3.0";
const TIMEOUT_MS = 6000;
/** Radius (metres) for the nearby-hotel candidate lookup. */
const SEARCH_RADIUS_M = 1000;
/** An unnamed candidate must be within this many km to be accepted. */
const MAX_UNNAMED_MATCH_KM = 0.3;

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

/** Number of nights between two `YYYY-MM-DD` dates (min 1; never NaN/0). */
export function nights(checkIn?: string, checkOut?: string): number {
  if (!checkIn || !checkOut) return 1;
  const a = Date.parse(checkIn);
  const b = Date.parse(checkOut);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 1;
  return Math.max(1, Math.round((b - a) / 86_400_000));
}

/** Lowercase, strip diacritics, collapse non-alphanumerics — for name matching. */
function normalizeName(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
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
  const target = normalizeName(q.name);
  const named = target
    ? candidates.filter((c) => {
        const n = normalizeName(c.name);
        return n.length > 0 && (n.includes(target) || target.includes(n));
      })
    : [];
  const pool = named.length > 0 ? named : candidates;
  const best = [...pool].sort((a, b) => dist(a) - dist(b))[0];
  if (!best) return null;
  // Name matches are trusted within the search radius; unnamed picks must be
  // essentially the same address.
  if (named.length === 0 && dist(best) > MAX_UNNAMED_MATCH_KM) return null;
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
  const res = await fetch(`${LITEAPI_BASE}/data/hotels?${params.toString()}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { "X-API-Key": apiKey },
  });
  if (!res.ok) return [];
  // NOTE: confirm the real candidate shape against the Step 0 fixture — coords
  // may arrive as `geoCode.lat/long` rather than flat `latitude/longitude`.
  const json = (await res.json()) as {
    data?: Array<{ id?: string; name?: string; latitude?: number; longitude?: number }>;
  };
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
  const res = await fetch(`${LITEAPI_BASE}/hotels/rates`, {
    method: "POST",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { "content-type": "application/json", "X-API-Key": apiKey },
    body: JSON.stringify({
      hotelIds: [hotelId],
      checkin: q.checkIn,
      checkout: q.checkOut,
      currency: opts.currency,
      guestNationality: opts.guestNationality.toUpperCase(),
      occupancies: [{ adults: q.adults ?? 2, children: [] }],
    }),
  });
  if (!res.ok) return { data: [] };
  return (await res.json()) as LiteRatesResponse;
}

/**
 * Fetch the lowest live nightly rate for THIS hotel: resolve the matching
 * nearby hotel id, then price just that one. Returns null on any failure
 * (missing coords/dates, no match, network/upstream error) so the caller falls
 * back to Tier 1 silently. Two cached server-side calls to a fixed host.
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

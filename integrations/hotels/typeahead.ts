// integrations/hotels/typeahead.ts
import { haversineKm } from "@openmapx/core/server";
import { nameMatches, normalizeName } from "./match.js";
import type { HotelQuery } from "./types.js";

export interface KeywordCandidate {
  id: string;
  name: string;
  lat?: number;
  lng?: number;
}

/** Max km between a candidate's coords and the queried hotel to accept the
 *  match (rejects same-named hotels in other cities). Mirrors
 *  resolveUberEatsStoreUrl's cap. */
const MAX_MATCH_KM = 1;

/**
 * Best name match (token-overlap; see {@link nameMatches}), validated by
 * proximity when both the candidate and the query carry coordinates. Mirrors
 * resolveUberEatsStoreUrl: prefer a name match, then nearest; reject a too-far
 * match. Pure + unit-testable.
 */
export function pickKeywordMatch(
  cands: KeywordCandidate[],
  q: HotelQuery,
): KeywordCandidate | null {
  if (!normalizeName(q.name)) return null;
  const named = cands.filter((c) => nameMatches(q.name, c.name));
  if (named.length === 0) return null;
  const dist = (c: KeywordCandidate) =>
    typeof q.lat === "number" &&
    typeof q.lng === "number" &&
    typeof c.lat === "number" &&
    typeof c.lng === "number"
      ? haversineKm(q.lat, q.lng, c.lat, c.lng)
      : Number.POSITIVE_INFINITY;
  // Pick the nearest by a single linear pass (a sort comparator would return
  // NaN when every distance is Infinity — no coords anywhere — giving an
  // engine-defined order). Replacing only on a strictly-smaller distance keeps
  // the original-order first match when all are Infinity, mirroring
  // resolveUberEatsStoreUrl.
  let best = named[0];
  let bestKm = dist(best);
  for (const c of named.slice(1)) {
    const km = dist(c);
    if (km < bestKm) {
      best = c;
      bestKm = km;
    }
  }
  // With coords on both sides, reject a too-far match; if either side lacks
  // coords (bestKm = Infinity), accept the name match (best we can do).
  if (Number.isFinite(bestKm) && bestKm > MAX_MATCH_KM) return null;
  return best;
}

// Trip.com /getHotelKeywords response — VERIFIED server-side paths (D0):
// id = keyword.hotelInfo.hotelId ; name = keyword.keywordContentInfo.keyword ;
// hotel flag = keywordContentInfo.tripType === "H" ; coords =
// keywordContentInfo.coordinateItemList[] where coordinateType is "GOOGLE"|"NORMAL".
// NOTE: keywordContentInfo.hotelId is null — use hotelInfo.hotelId.
interface TripKeyword {
  keyword?: {
    hotelInfo?: { hotelId?: string | null };
    keywordContentInfo?: {
      keyword?: string;
      tripType?: string;
      coordinateItemList?: Array<{
        coordinateType?: string;
        latitude?: string;
        longitude?: string;
      }>;
    };
  };
}
interface TripKeywordsResp {
  data?: { mainKeywordList?: { keywords?: TripKeyword[] } };
}

/** Pure: extract specific-hotel candidates from a Trip.com getHotelKeywords
 *  response. Drops landmarks/cities (tripType !== "H") and id-less entries. */
export function parseTripcomKeywords(json: TripKeywordsResp): KeywordCandidate[] {
  const out: KeywordCandidate[] = [];
  for (const k of json.data?.mainKeywordList?.keywords ?? []) {
    const ci = k.keyword?.keywordContentInfo;
    const id = k.keyword?.hotelInfo?.hotelId;
    if (!id || !ci?.keyword || ci.tripType !== "H") continue;
    const geo = (ci.coordinateItemList ?? []).find(
      (c) => c.coordinateType === "GOOGLE" || c.coordinateType === "NORMAL",
    );
    const rawLat = geo ? Number(geo.latitude) : Number.NaN;
    const rawLng = geo ? Number(geo.longitude) : Number.NaN;
    // Trip.com uses -1 AND the (0,0) null-island pair as "no coordinate"
    // placeholders; treat both as absent so pickKeywordMatch doesn't reject a
    // genuine match on a bogus thousands-of-km distance.
    const placeholder = (v: number) => !Number.isFinite(v) || v === -1;
    const nullIsland = rawLat === 0 && rawLng === 0;
    const valid = !placeholder(rawLat) && !placeholder(rawLng) && !nullIsland;
    out.push({
      id,
      name: ci.keyword,
      lat: valid ? rawLat : undefined,
      lng: valid ? rawLng : undefined,
    });
  }
  return out;
}

const TYPEAHEAD_TIMEOUT_MS = 6000;

/**
 * Resolve a hotel's Trip.com internal id via its public getHotelKeywords
 * typeahead. Clean server-side POST (no cookies/anti-bot context needed, per
 * D0). Returns null on any failure or no confident match, so callers fall back
 * to Wikidata / omit the row.
 */
export async function resolveTripcomHotelId(q: HotelQuery): Promise<string | null> {
  try {
    const res = await fetch("https://www.trip.com/restapi/soa2/34951/getHotelKeywords", {
      method: "POST",
      signal: AbortSignal.timeout(TYPEAHEAD_TIMEOUT_MS),
      headers: { "content-type": "application/json", accept: "application/json", locale: "en-US" },
      body: JSON.stringify({
        queryInfo: { keyword: q.name, actionType: "destination" },
        head: {
          platform: "PC",
          bu: "IBU",
          group: "trip",
          locale: "en-US",
          region: "US",
          currency: "USD",
        },
      }),
    });
    if (!res.ok) return null;
    return (
      pickKeywordMatch(parseTripcomKeywords((await res.json()) as TripKeywordsResp), q)?.id ?? null
    );
  } catch {
    return null;
  }
}

/** Typeahead resolvers by OTA id. Per D0, ONLY Trip.com is wired:
 *  - Agoda resolves an id but it isn't deep-linkable (needs a signed `asq`),
 *  - Expedia/Hotels.com /api/v4/typeahead is 429 rate-limited + CAPTCHA-walled.
 *  Those three are Wikidata-only and intentionally absent here. */
export const TYPEAHEAD_RESOLVERS: Record<string, (q: HotelQuery) => Promise<string | null>> = {
  tripcom: resolveTripcomHotelId,
};

// integrations/hotels/idResolver.ts
import type { HotelProviderConfig, HotelQuery } from "./types.js";
import type { WikidataOtaIds } from "./wikidata.js";

const enc = encodeURIComponent;

/**
 * Build the exact-hotel deep link for an OTA from its resolved hotel id + the
 * stay (dates/occupancy). Returns null when the id is empty or the OTA isn't
 * id-buildable. Pure + unit-testable; the network resolution that produces `id`
 * lives elsewhere.
 *
 * Each base path matches the OTA's authoritative Wikidata formatter URL (P1630),
 * confirmed 2026-05-31: Expedia `…/$1.Hotel-Information`, Booking `…/hotel/$1.html`,
 * Hotels.com `…/$1/` (trailing slash), Agoda `…/$1.html`, Trip.com — we use the
 * `hotels/detail?hotelid=$1` form Google links to (cleanly accepts date params)
 * over the formatter's SEO path. The date/occupancy query params are best-effort
 * for Expedia/Hotels.com/Agoda (their sites are CAPTCHA-walled to live checks);
 * the exact-hotel base path is the verified part. Booking + Trip.com were also
 * confirmed live.
 */
export function buildExactDeepLink(
  ota: string,
  id: string,
  q: HotelQuery,
  _config: HotelProviderConfig,
): string | null {
  if (!id) return null;
  const adults = q.adults ?? 2;
  const rooms = q.rooms ?? 1;
  switch (ota) {
    case "tripcom": {
      const p = new URLSearchParams({ hotelid: id, adult: String(adults), crn: String(rooms) });
      if (q.checkIn) p.set("checkin", q.checkIn);
      if (q.checkOut) p.set("checkout", q.checkOut);
      return `https://www.trip.com/hotels/detail?${p.toString()}`;
    }
    case "expedia": {
      const p = new URLSearchParams();
      if (q.checkIn) p.set("chkin", q.checkIn);
      if (q.checkOut) p.set("chkout", q.checkOut);
      p.set("rm1", `a${adults}`);
      return `https://www.expedia.com/${enc(id)}.Hotel-Information?${p.toString()}`;
    }
    case "hotelscom": {
      const p = new URLSearchParams();
      if (q.checkIn) p.set("chkin", q.checkIn);
      if (q.checkOut) p.set("chkout", q.checkOut);
      p.set("rm1", `a${adults}`);
      // P3898 formatter is `…/$1/` — the trailing slash matters for routing.
      return `https://www.hotels.com/${enc(id)}/?${p.toString()}`;
    }
    case "agoda": {
      // id is the P6008 slug path (e.g. "paradise-inn-.../hotel/alexandria-eg");
      // the P6008 formatter appends `.html`.
      const p = new URLSearchParams({ adults: String(adults), rooms: String(rooms) });
      if (q.checkIn) p.set("checkIn", q.checkIn);
      if (q.checkOut) p.set("checkOut", q.checkOut);
      return `https://www.agoda.com/${id.replace(/^\//, "")}.html?${p.toString()}`;
    }
    case "booking": {
      const p = new URLSearchParams({
        group_adults: String(adults),
        no_rooms: String(rooms),
        group_children: "0",
      });
      if (q.checkIn) p.set("checkin", q.checkIn);
      if (q.checkOut) p.set("checkout", q.checkOut);
      return `https://www.booking.com/hotel/${id}.html?${p.toString()}`;
    }
    default:
      return null;
  }
}

/** Where a resolved id came from (for attribution/debugging). */
export type IdSource = "wikidata" | "typeahead";

/** A resolved OTA hotel id + its provenance. */
export interface ResolvedHotelId {
  id: string;
  source: IdSource;
}

/** Minimal cache surface this resolver needs (a CacheClient satisfies it). */
export interface IdResolverCache {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlSeconds?: number): Promise<void>;
}

/** Injected dependencies — real wiring supplies these in index.ts. */
export interface IdResolverDeps {
  /** Fetch a hotel's OTA ids from its Wikidata entity. */
  wikidata: (qid: string) => Promise<WikidataOtaIds>;
  /** Per-OTA typeahead resolvers (only the wired OTAs are present). */
  typeahead: Record<string, (q: HotelQuery) => Promise<string | null>>;
  cache: IdResolverCache;
  /** Whether the (grey/brittle) typeahead layer is allowed. Wikidata is always on. */
  typeaheadEnabled: boolean;
}

/** Ids are stable → cache positives for a week. */
const ID_POSITIVE_TTL = 7 * 24 * 60 * 60;
/** Retry unresolved hotels sooner (an id may appear, or typeahead get re-enabled). */
const ID_NEGATIVE_TTL = 6 * 60 * 60;

/** The WikidataOtaIds field that holds `ota`'s id (slug preferred for Agoda). */
function wikidataIdFor(ota: string, ids: WikidataOtaIds): string | undefined {
  switch (ota) {
    case "expedia":
      return ids.expedia;
    case "booking":
      return ids.booking;
    case "hotelscom":
      return ids.hotelscom;
    case "agoda":
      return ids.agoda;
    case "tripcom":
      return ids.tripcom;
    default:
      return undefined;
  }
}

/** Stable per-hotel cache discriminator: the Wikidata qid when known, else
 *  name + rounded coords. Falls back to name + city/country when coords are
 *  absent so two same-named hotels don't share a cache entry (the real caller
 *  always has coords, but this keeps the resolver correct standalone). */
function hotelKey(q: HotelQuery): string {
  if (q.wikidata) return `wd:${q.wikidata}`;
  const lat = typeof q.lat === "number" ? q.lat.toFixed(4) : "";
  const lng = typeof q.lng === "number" ? q.lng.toFixed(4) : "";
  const geo =
    lat || lng ? `${lat}:${lng}` : `${(q.city ?? "").toLowerCase()}:${q.countryCode ?? ""}`;
  return `q:${q.name.toLowerCase()}:${geo}`;
}

/** Fetch + cache the full WikidataOtaIds for the hotel once, so resolving N
 *  OTAs for the same hotel costs a single Wikidata request. Empty when the
 *  hotel carries no `wikidata` qid. */
async function wikidataIdsCached(q: HotelQuery, deps: IdResolverDeps): Promise<WikidataOtaIds> {
  if (!q.wikidata) return {};
  const key = `hotels:wd:${q.wikidata}`;
  const cached = await deps.cache.get<WikidataOtaIds>(key);
  if (cached != null) return cached;
  const ids = await deps.wikidata(q.wikidata);
  // An empty result (entity has no OTA claims yet) is cached only briefly, so a
  // hotel that gets its Wikidata ids added is picked up within hours, not a week.
  await deps.cache.set(key, ids, Object.keys(ids).length > 0 ? ID_POSITIVE_TTL : ID_NEGATIVE_TTL);
  return ids;
}

/**
 * Resolve an OTA's internal hotel id for THIS hotel: Wikidata (clean, preferred)
 * → the OTA's typeahead (only if enabled AND wired) → null. Cached per (ota,
 * hotel): positives for a week, negatives briefly (empty-string sentinel,
 * distinct from a cache miss). Returns `{ id, source }` or null so callers omit
 * the row when no exact id exists.
 */
export async function resolveOtaHotelId(
  ota: string,
  q: HotelQuery,
  deps: IdResolverDeps,
): Promise<ResolvedHotelId | null> {
  const key = `hotels:id:${ota}:${hotelKey(q)}`;
  const cached = await deps.cache.get<ResolvedHotelId | "">(key);
  if (cached != null) return cached || null; // "" negative sentinel → null

  let result: ResolvedHotelId | null = null;
  const wdId = wikidataIdFor(ota, await wikidataIdsCached(q, deps));
  if (wdId) {
    result = { id: wdId, source: "wikidata" };
  } else if (deps.typeaheadEnabled) {
    const resolver = deps.typeahead[ota];
    if (resolver) {
      const id = await resolver(q);
      if (id) result = { id, source: "typeahead" };
    }
  }

  await deps.cache.set(key, result ?? "", result ? ID_POSITIVE_TTL : ID_NEGATIVE_TTL);
  return result;
}

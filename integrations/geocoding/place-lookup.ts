import { OPENSTREETMAP_ATTRIBUTION } from "@openmapx/mobility-core/attribution";
import { snapshotContributors, withContributors } from "@openmapx/mobility-core/contributors";
import { LRUCache } from "lru-cache";
/**
 * Nominatim place detail lookups.
 * Separate from nominatim geocoding (which handles geocoding/autocomplete)
 * because lookups and reverse-geocode require different endpoints and params.
 */

import {
  type AddressEvidence,
  type AreaGeometry,
  type Attribution,
  addressComponentsFromOsmTags,
  type BBox,
  createPlace,
  fetchJson,
  haversineMeters,
  type OsmFilter,
  type OsmIdentity,
  type OverpassNode,
  type OverpassWay,
  overpassQuery,
  type Place,
  type PlaceAddressComponents,
  type PlaceIds,
  parseId,
  sanitizeAddressComponents,
} from "@openmapx/core";
import { formatAddress, formatStreetLine } from "./format-address.js";
import { resolveOsmLabel } from "./osm-label.js";

function normalizeIdValue(s: string | undefined): string {
  return s?.trim().toLowerCase() ?? "";
}

/**
 * Corporate suffixes and country-of-incorporation suffixes that carry no
 * identity signal — stripped before token comparison so "Shell" matches
 * "Shell Deutschland Oil GmbH" and "Dott" matches "Dott Pay AB".
 */
const NAME_FILLER_TOKENS = new Set([
  "gmbh",
  "ag",
  "ltd",
  "inc",
  "llc",
  "plc",
  "se",
  "kg",
  "ohg",
  "ug",
  "ab",
  "sa",
  "srl",
  "bv",
  "co",
  "corp",
  "company",
  "holding",
  "holdings",
  "group",
  "international",
  "deutschland",
  "deutsche",
  "europe",
  "pay",
  "mobility",
]);

function nameTokens(value: string): string[] {
  return value
    .split(/[\s.,/_\-&]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && !NAME_FILLER_TOKENS.has(t));
}

/** True when every non-empty token of `needle` appears in `haystack`. */
function nameMatches(needle: string, haystack: string): boolean {
  if (!needle || !haystack) return false;
  if (needle === haystack) return true;
  const needleTokens = nameTokens(needle);
  const haystackTokens = new Set(nameTokens(haystack));
  if (needleTokens.length === 0 || haystackTokens.size === 0) return false;
  return needleTokens.every((t) => haystackTokens.has(t));
}

function nameMatchesEitherWay(a: string, b: string): boolean {
  return nameMatches(a, b) || nameMatches(b, a);
}

/**
 * Decide whether an OSM element belongs to the data-source item we resolved
 * from. Match is intentionally loose — any single hit on ref/operator/network/
 * brand accepts the candidate — but constrained enough to stop a Dott
 * station from snapping to an optician kiosk that happens to be tagged
 * `amenity=bicycle_rental`. For name fields, the shorter side's tokens must
 * all appear in the longer side (case-insensitive, common corp suffixes
 * stripped).
 */
function osmMatchesIdentity(tags: Record<string, string>, identity: OsmIdentity): boolean {
  const refExp = normalizeIdValue(identity.ref);
  if (refExp) {
    const refTag = normalizeIdValue(tags.ref);
    if (refTag && refTag === refExp) return true;
    const gbfsRef = normalizeIdValue(tags["gbfs:station_id"]);
    if (gbfsRef && gbfsRef === refExp) return true;
  }

  const opExp = normalizeIdValue(identity.operator);
  const netExp = normalizeIdValue(identity.network);
  const brandExp = normalizeIdValue(identity.brand);
  const opTag = normalizeIdValue(tags.operator);
  const netTag = normalizeIdValue(tags.network);
  const brandTag = normalizeIdValue(tags.brand);

  for (const expected of [opExp, netExp, brandExp]) {
    if (!expected) continue;
    for (const candidate of [opTag, netTag, brandTag]) {
      if (!candidate) continue;
      if (nameMatchesEitherWay(expected, candidate)) return true;
    }
  }

  return false;
}

function buildIds(result: NominatimDetailResult, requestId: string): PlaceIds {
  const osmRef = `${result.osm_type}/${result.osm_id}`;
  const ids: PlaceIds = { osm: osmRef };
  // Carry any non-OSM scheme from the request forward — e.g. a `dataSource:`
  // item that maps to an OSM node still needs its original identity for
  // client-side dispatch (filter lookup, reviews, saved-places, etc.).
  const parsed = parseId(requestId);
  if (parsed && parsed.scheme !== "osm" && !ids[parsed.scheme]) {
    ids[parsed.scheme] = parsed.value;
  }
  return ids;
}

// Populated by setup(ctx) from the resolved integration config cascade.
let NOMINATIM_URL = "https://nominatim.openstreetmap.org";
export function setPlaceLookupNominatimUrl(value: string | undefined): void {
  const next = value && value.length > 0 ? value : "https://nominatim.openstreetmap.org";
  if (next !== NOMINATIM_URL) clearPlaceLookupCaches(lookupCacheAvailable);
  NOMINATIM_URL = next;
}

const DEFAULT_HEADERS = {
  "Accept-Language": "en",
};

function headersForLang(lang?: string): Record<string, string> {
  if (!lang) return DEFAULT_HEADERS;
  return { ...DEFAULT_HEADERS, "Accept-Language": lang };
}

interface NominatimAddress extends PlaceAddressComponents {}

function nominatimAddressEvidence(
  result: NominatimDetailResult,
  method: "provider-address" | "reverse",
): AddressEvidence | undefined {
  const components = sanitizeAddressComponents(result.address);
  if (Object.keys(components).length === 0) return undefined;
  return {
    components,
    source: "geocoding-nominatim",
    method,
    recordId: `osm:${result.osm_type}/${result.osm_id}`,
  };
}

interface NominatimDetailResult {
  place_id: number;
  osm_type: string;
  osm_id: number;
  lat: string;
  lon: string;
  display_name: string;
  /** jsonv2 calls this `category`; older Nominatim builds returned `class`. */
  category?: string;
  class?: string;
  type: string;
  /** Single-name field returned when `addressdetails=1` is requested. */
  name?: string;
  address: NominatimAddress;
  extratags?: Record<string, string | undefined>;
  /** Returned when `namedetails=1` — contains `iata`, `icao`, `ref`, `name:*` localisations. */
  namedetails?: Record<string, string | undefined>;
}

/**
 * Keys from Nominatim's `namedetails` block that knowledge / matching layers
 * downstream may want as raw OSM tags. We deliberately exclude `name` and
 * `name:*` localisation variants — those are display-only and would clutter
 * the OSM-tag panel without adding matching value.
 */
const NAMEDETAILS_TAG_ALLOWLIST = new Set([
  "iata",
  "icao",
  "ref",
  "ref:iata",
  "ref:icao",
  "ref:faa",
  "faa",
  "gps_code",
  "local_code",
]);

function toPlace(
  r: NominatimDetailResult,
  id: string,
  method: "provider-address" | "reverse" = "provider-address",
): Place {
  const {
    opening_hours,
    phone,
    website,
    "contact:phone": contactPhone,
    "contact:website": contactWebsite,
    ...rest
  } = r.extratags ?? {};

  const osmTags: Record<string, string> = {};
  for (const [k, v] of Object.entries(rest)) {
    if (v !== undefined) osmTags[k] = v;
  }

  // The primary classification tag (e.g. `aeroway=aerodrome`, `amenity=restaurant`)
  // is not in Nominatim's `extratags` — it lives in `category`/`class` + `type`.
  // Without this, downstream knowledge providers can't gate on OSM tags.
  const osmClass = r.category ?? r.class;
  if (osmClass && r.type && !osmTags[osmClass]) {
    osmTags[osmClass] = r.type;
  }

  // Merge curated keys from `namedetails` — gives us IATA/ICAO/ref codes that
  // OSM stores under `name*` tags rather than `extratags`.
  if (r.namedetails) {
    for (const [k, v] of Object.entries(r.namedetails)) {
      if (v !== undefined && NAMEDETAILS_TAG_ALLOWLIST.has(k) && !osmTags[k]) {
        osmTags[k] = v;
      }
    }
  }

  const components = sanitizeAddressComponents(r.address);
  const address = formatAddress(components) || r.display_name;
  // Address-type places (buildings/house numbers) have no POI name. Derive a
  // proper street line ("Kinderhauser Straße 40") instead of falling back to
  // display_name's first segment, which is the bare house number in DE/AT/CH.
  const name =
    r.name?.trim() || formatStreetLine(components) || r.display_name.split(",")[0].trim();
  const city =
    components.city ??
    components.town ??
    components.village ??
    components.municipality ??
    components.county;

  return createPlace({
    primaryScheme: "osm",
    contributors: snapshotContributors([OPENSTREETMAP_ATTRIBUTION]),
    ids: buildIds(r, id),
    name,
    address,
    addressEvidence: nominatimAddressEvidence(r, method),
    city,
    countryCode: components.country_code ?? undefined,
    coordinates: [Number.parseFloat(r.lon), Number.parseFloat(r.lat)],
    category: osmClass ? resolveOsmLabel(osmClass, r.type) : r.type,
    phone: phone ?? contactPhone,
    website: website ?? contactWebsite,
    openingHours: opening_hours,
    osmTags: Object.keys(osmTags).length > 0 ? osmTags : undefined,
  });
}

async function fetchNominatim<T>(url: URL, lang?: string): Promise<T> {
  return fetchJson<T>(url.toString(), {
    headers: headersForLang(lang),
    errorMessage: ({ status }) => `Nominatim error ${status}: ${url.pathname}`,
  });
}

const OSM_TYPE_PREFIX: Record<string, string> = {
  node: "N",
  way: "W",
  relation: "R",
};

/**
 * Fetch place details by OSM type + ID using Nominatim /lookup.
 * e.g. lookupByOsmRef("node", "12345")
 */
export async function lookupByOsmRef(
  osmType: string,
  osmId: string,
  originalId: string,
  lang?: string,
): Promise<Place> {
  const prefix = OSM_TYPE_PREFIX[osmType];
  if (!prefix) throw new Error(`Unknown OSM type: ${osmType}`);

  const url = new URL(`${NOMINATIM_URL}/lookup`);
  url.searchParams.set("osm_ids", `${prefix}${osmId}`);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("extratags", "1");
  url.searchParams.set("namedetails", "1");

  // /lookup returns an array; we asked for exactly one ID
  const data = await fetchNominatim<NominatimDetailResult[]>(url, lang);
  if (!data[0]) throw new Error(`Nominatim found no result for ${prefix}${osmId}`);
  return toPlace(data[0], originalId);
}

interface NominatimBoundaryResult {
  osm_type: string;
  osm_id: number;
  /** [minlat, maxlat, minlon, maxlon] as strings. */
  boundingbox?: [string, string, string, string];
  geojson?: { type: string; coordinates: unknown };
}

/**
 * Fetch the administrative-boundary outline for an OSM element via Nominatim
 * `/lookup?polygon_geojson=1`. Returns the boundary polygon plus its extent,
 * or null when the element has no area geometry (e.g. a point/way that isn't a
 * boundary, or Nominatim is unreachable).
 *
 * `osmRef` is the canonical `${osm_type}/${osm_id}` string carried on
 * `place.ids.osm`. `polygon_threshold` applies a small Douglas-Peucker
 * simplification (~50 m) to keep city/region payloads reasonable.
 */
export async function fetchOsmBoundary(
  osmRef: string,
  lang?: string,
): Promise<{ boundary: AreaGeometry; boundingBox?: BBox; contributors: Attribution[] } | null> {
  const [osmType, osmId] = osmRef.split("/");
  const prefix = OSM_TYPE_PREFIX[osmType];
  if (!prefix || !osmId) return null;

  const url = new URL(`${NOMINATIM_URL}/lookup`);
  url.searchParams.set("osm_ids", `${prefix}${osmId}`);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("polygon_geojson", "1");
  url.searchParams.set("polygon_threshold", "0.0005");

  try {
    const data = await fetchNominatim<NominatimBoundaryResult[]>(url, lang);
    const result = data[0];
    const geojson = result?.geojson;
    if (!geojson || (geojson.type !== "Polygon" && geojson.type !== "MultiPolygon")) {
      return null;
    }
    const boundary = geojson as AreaGeometry;

    let boundingBox: BBox | undefined;
    if (result.boundingbox?.length === 4) {
      const [south, north, west, east] = result.boundingbox.map(Number);
      if ([south, north, west, east].every(Number.isFinite)) {
        boundingBox = [west, south, east, north];
      }
    }

    return {
      boundary,
      boundingBox,
      contributors: snapshotContributors([OPENSTREETMAP_ATTRIBUTION]),
    };
  } catch {
    return null;
  }
}

/**
 * Reverse-geocode by coordinates to find the nearest OSM element.
 * Returns a Place with address, opening hours, phone, etc. from the closest
 * OSM node/way. Unlike lookupByNameAndCoords, this always succeeds if there's
 * any OSM data near the coordinates -- no name matching required.
 */
export async function lookupByCoords(
  lat: number,
  lng: number,
  originalId: string,
  lang?: string,
): Promise<Place | null> {
  const url = new URL(`${NOMINATIM_URL}/reverse`);
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lng));
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("extratags", "1");
  url.searchParams.set("namedetails", "1");
  url.searchParams.set("zoom", "18"); // Building-level precision

  try {
    const result = await fetchNominatim<NominatimDetailResult>(url, lang);
    if (!result?.osm_id) return null;
    return toPlace(result, originalId, "reverse");
  } catch {
    return null;
  }
}

/**
 * Search Nominatim by name within a bounding box around the given coordinates,
 * then return the closest matching result.
 *
 * This is the correct fallback for non-OSM IDs (e.g. MapTiler): a reverse
 * geocode by coordinates alone returns whatever element is geometrically
 * closest, which is often a completely different place. Searching by name
 * + proximity correctly disambiguates "school" from "pitch next door".
 *
 * Returns null if no result is found within MAX_DISTANCE_M metres.
 */
const BBOX_DEGREES = 0.015; // ~1.5 km half-width
const MAX_DISTANCE_M = 500;

// Cache city names by rounded coordinates (~11km grid)
const cityNameCache = new Map<string, { city: string | null; expiresAt: number }>();
const CITY_NAME_TTL_MS = 3_600_000; // 1h

// Country only changes at borders, so a coarse 1° grid (~111 km cell) and a
// 24h TTL are sufficient. Shared with the nearby-places route so opening-hours
// public-holiday rules can be evaluated against the right country.
// An entry budget for small country-code results, not an estimated heap-byte limit.
const countryCodeCache = new LRUCache<string, { countryCode: string | null; expiresAt: number }>({
  max: 4096,
  ttlResolution: 0,
  perf: { now: () => Date.now() },
});
const COUNTRY_CODE_TTL_MS = 24 * 60 * 60 * 1000;
let lookupGeneration = 0;
let lookupCacheAvailable = true;

export function clearPlaceLookupCaches(available = true): void {
  lookupGeneration++;
  lookupCacheAvailable = available;
  countryCodeCache.clear();
  cityNameCache.clear();
}

/**
 * Reverse-geocode coordinates to a city name (city-level zoom).
 * Cached aggressively since the same viewport area maps to the same city.
 */
export async function reverseGeocodeCity(
  lat: number,
  lng: number,
  lang?: string,
): Promise<string | null> {
  const effectiveLang = lang ?? "en";
  const key = `${Math.round(lat * 10) / 10},${Math.round(lng * 10) / 10}:${effectiveLang}`;
  const generation = lookupGeneration;
  const cached = lookupCacheAvailable ? cityNameCache.get(key) : undefined;
  if (cached && cached.expiresAt > Date.now()) return cached.city;

  try {
    const url = new URL(`${NOMINATIM_URL}/reverse`);
    url.searchParams.set("lat", String(lat));
    url.searchParams.set("lon", String(lng));
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("zoom", "10");

    const result = await fetchNominatim<NominatimDetailResult>(url, lang);
    const city = result?.address?.city ?? result?.address?.town ?? result?.address?.village ?? null;

    if (lookupCacheAvailable && generation === lookupGeneration) {
      cityNameCache.set(key, { city, expiresAt: Date.now() + CITY_NAME_TTL_MS });
    }
    return city;
  } catch {
    return null;
  }
}

/**
 * Reverse-geocode coordinates to a lowercase ISO 3166-1 alpha-2 country code.
 * Country-level zoom + 1° grid cache: cheap and rarely missed (only when the
 * lookup straddles a small border country boundary). Returns null on
 * unreachable upstream so callers can fall back gracefully.
 */
export async function reverseGeocodeCountry(lat: number, lng: number): Promise<string | null> {
  const endpoint = NOMINATIM_URL;
  const generation = lookupGeneration;
  const key = `${endpoint}:${Math.round(lat)},${Math.round(lng)}`;
  const cached = lookupCacheAvailable ? countryCodeCache.get(key) : undefined;
  if (cached && cached.expiresAt > Date.now()) return cached.countryCode;

  try {
    const url = new URL(`${endpoint}/reverse`);
    url.searchParams.set("lat", String(lat));
    url.searchParams.set("lon", String(lng));
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("zoom", "3");

    const result = await fetchNominatim<NominatimDetailResult>(url);
    const countryCode = result?.address?.country_code?.toLowerCase() ?? null;

    if (lookupCacheAvailable && generation === lookupGeneration) {
      countryCodeCache.set(
        key,
        {
          countryCode,
          expiresAt: Date.now() + COUNTRY_CODE_TTL_MS,
        },
        { ttl: COUNTRY_CODE_TTL_MS },
      );
    }
    return countryCode;
  } catch {
    return null;
  }
}

export async function lookupByNameAndCoords(
  name: string,
  lat: number,
  lng: number,
  originalId: string,
  lang?: string,
): Promise<Place | null> {
  // Nominatim viewbox: left,top,right,bottom = minLng,maxLat,maxLng,minLat
  const viewbox = [
    lng - BBOX_DEGREES,
    lat + BBOX_DEGREES,
    lng + BBOX_DEGREES,
    lat - BBOX_DEGREES,
  ].join(",");

  const url = new URL(`${NOMINATIM_URL}/search`);
  url.searchParams.set("q", name);
  url.searchParams.set("viewbox", viewbox);
  url.searchParams.set("bounded", "1");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("extratags", "1");
  url.searchParams.set("namedetails", "1");
  url.searchParams.set("limit", "5");

  const results = await fetchNominatim<NominatimDetailResult[]>(url, lang);
  if (results.length === 0) return null;

  // A Wikidata place prefers the objects tagged as that item, so Leipzig
  // Hauptbahnhof resolves to its station rather than a nearer stop position.
  // Among the rest, the result closest to the geocoder's coordinates wins.
  const qid = originalId.startsWith("wikidata:") ? originalId.slice("wikidata:".length) : null;
  const isItem = (r: NominatimDetailResult) => qid !== null && r.extratags?.wikidata === qid;
  const best = results
    .map((r) => ({
      r,
      item: isItem(r),
      dist: haversineMeters(lat, lng, Number.parseFloat(r.lat), Number.parseFloat(r.lon)),
    }))
    .sort((a, b) => Number(b.item) - Number(a.item) || a.dist - b.dist)[0];

  if (best.dist > MAX_DISTANCE_M) return null;

  return toPlace(best.r, originalId);
}

/**
 * Reverse-geocode coordinates to a structured street address (zoom=18, building level).
 * Returns address components as contextual reverse evidence, without borrowing
 * a nearby building's house number or other POI details.
 */
export async function lookupAddressByCoords(
  lat: number,
  lng: number,
): Promise<{
  address: string;
  city?: string;
  countryCode?: string;
  addressEvidence: AddressEvidence;
} | null> {
  const url = new URL(`${NOMINATIM_URL}/reverse`);
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lng));
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("zoom", "18");

  try {
    const result = await fetchNominatim<NominatimDetailResult>(url);
    if (!result?.osm_id) return null;
    const evidence = nominatimAddressEvidence(result, "reverse");
    if (!evidence) return null;
    const addr = evidence.components;
    if (!addr.road && !addr.place && !addr.house && !addr.full) return null;
    const address = formatAddress(addr);
    if (!address) return null;
    return {
      address,
      city: addr.city ?? addr.town ?? addr.village ?? addr.municipality ?? addr.county,
      countryCode: addr.country_code,
      addressEvidence: evidence,
    };
  } catch {
    return null;
  }
}

const OVERPASS_BBOX_DEG = 0.002; // ~220 m half-width — tight enough to avoid neighbouring stations
const OVERPASS_MAX_DISTANCE_M = 150;

/**
 * Find the OSM element nearest to [lat, lng] that matches one of the given
 * tag filters, using Overpass. Returns null if nothing is found within
 * OVERPASS_MAX_DISTANCE_M metres or if Overpass is unavailable.
 *
 * Used to enrich data-source items (fuel, EV, bike sharing, parking, car sharing)
 * with the correct OSM node/way rather than a plain reverse geocode which returns
 * whatever element is geometrically closest regardless of type.
 *
 * When `identity` is provided, candidates must match at least one identity
 * field (ref, operator, network, brand — case-insensitive). This stops a Dott
 * bike station from snapping to a co-located optician kiosk whose OSM node
 * happens to carry `amenity=bicycle_rental`. Without an identity hint, the
 * closest matching feature is selected.
 */
export async function lookupByOsmFilters(
  lat: number,
  lng: number,
  filters: OsmFilter[],
  originalId: string,
  identity?: OsmIdentity,
): Promise<Place | null> {
  const bboxStr = `${lat - OVERPASS_BBOX_DEG},${lng - OVERPASS_BBOX_DEG},${lat + OVERPASS_BBOX_DEG},${lng + OVERPASS_BBOX_DEG}`;

  const escapeOql = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const lines = filters
    .flatMap((f) => [
      `node["${escapeOql(f.key)}"="${escapeOql(f.value)}"](${bboxStr});`,
      `way["${escapeOql(f.key)}"="${escapeOql(f.value)}"](${bboxStr});`,
    ])
    .join("\n  ");
  const query = `[out:json][timeout:10];\n(\n  ${lines}\n);\nout center 10;`;

  const hasIdentity =
    identity !== undefined &&
    Boolean(identity.ref || identity.operator || identity.network || identity.brand);

  try {
    const data = await overpassQuery(query);
    if (!data.elements.length) return null;

    const candidates = data.elements
      .filter((el): el is OverpassNode | OverpassWay => el.type === "node" || el.type === "way")
      .map((el) => {
        let elLat: number;
        let elLon: number;
        if (el.type === "node") {
          elLat = el.lat;
          elLon = el.lon;
        } else if (el.center) {
          elLat = el.center.lat;
          elLon = el.center.lon;
        } else {
          return null;
        }
        return { el, elLat, elLon, dist: haversineMeters(lat, lng, elLat, elLon) };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null)
      .filter((c) => c.dist <= OVERPASS_MAX_DISTANCE_M)
      .sort((a, b) => a.dist - b.dist);

    if (candidates.length === 0) return null;

    let best = candidates[0];
    if (hasIdentity && identity) {
      const matched = candidates.find((c) => osmMatchesIdentity(c.el.tags ?? {}, identity));
      if (!matched) return null;
      best = matched;
    }

    const place = overpassElementToPlace(best.el, best.elLat, best.elLon, originalId);
    return place ? withContributors(place, data.contributors ?? [OPENSTREETMAP_ATTRIBUTION]) : null;
  } catch {
    return null;
  }
}

function overpassElementToPlace(
  el: OverpassNode | OverpassWay,
  lat: number,
  lng: number,
  originalId: string,
): Place | null {
  const tags = el.tags ?? {};
  const name = tags.name ?? "";
  const phone = tags.phone ?? tags["contact:phone"];
  const website = tags.website ?? tags["contact:website"];
  const openingHours = tags.opening_hours;

  const components = addressComponentsFromOsmTags(tags);
  const city = components.city ?? components.town;
  const countryCode = components.country_code;
  // Address from structured addr:* tags only — don't fall back to the element name
  // because data source items use selectedPlace.name for identity already.
  const hasPremises = Boolean(
    components.road || components.place || components.house || components.full,
  );
  const address = hasPremises ? formatAddress(components, { appendCountry: false }) : "";

  const osmTags: Record<string, string> = { ...tags };

  const osmRef = `${el.type}/${el.id}`;
  const ids: PlaceIds = { osm: osmRef };
  const parsed = parseId(originalId);
  if (parsed && parsed.scheme !== "osm" && !ids[parsed.scheme]) {
    ids[parsed.scheme] = parsed.value;
  }

  return createPlace({
    primaryScheme: "osm",
    contributors: snapshotContributors([OPENSTREETMAP_ATTRIBUTION]),
    ids,
    name,
    address,
    addressEvidence: address
      ? { components, source: "overpass", method: "osm-tags", recordId: `osm:${osmRef}` }
      : undefined,
    city,
    countryCode,
    coordinates: [lng, lat],
    phone,
    website,
    openingHours,
    osmTags: Object.keys(osmTags).length > 0 ? osmTags : undefined,
  });
}

import {
  type AirportType,
  createPlace,
  normalizeSearchTerm,
  type Place,
  type SearchSuggestionProviderResult,
  type SearchSuggestionQuery,
} from "@openmapx/core";
import type { IntegrationContext, SearchSuggestionProvider } from "@openmapx/integration-framework";
import {
  type AirportRecord,
  type AirportSearchMatch,
  haversineKm,
  lookupAirportRecord,
  queryAirportsInBbox,
  searchAirportMatches,
  searchAirports,
} from "@openmapx/ourairports-data";
import { registerPlaceResolver } from "@openmapx/place-ids";
import { startBackgroundLoad, stopBackgroundLoad } from "./data.js";
import { createOurAirportsSource } from "./provider.js";

const SEARCH_MIN_LEN = 2;
const SEARCH_MAX_LIMIT = 20;
const SEARCH_DEFAULT_LIMIT = 8;
const NEAREST_DEFAULT_LIMIT = 5;
const NEAREST_MAX_LIMIT = 10;

interface SearchHit {
  id: number;
  ident: string;
  name: string;
  type: AirportType;
  iata?: string;
  icao?: string;
  lat: number;
  lng: number;
  municipality?: string;
  isoCountry?: string;
  scheduledService: boolean;
}

interface NearestHit extends SearchHit {
  /** Great-circle distance from the query point, in kilometres (rounded). */
  distanceKm: number;
}

function recordToHit(r: AirportRecord): SearchHit {
  return {
    id: r.id,
    ident: r.ident,
    name: r.name,
    type: r.type,
    iata: r.iata,
    icao: r.icao,
    lat: r.lat,
    lng: r.lng,
    municipality: r.municipality,
    isoCountry: r.isoCountry,
    scheduledService: r.scheduledService,
  };
}

type AirportMatchSearch = (
  log: IntegrationContext["log"],
  query: string,
  limit?: number,
) => Promise<AirportSearchMatch[]>;

export function createOurAirportsSuggestionProvider(
  ctx: IntegrationContext,
  search: AirportMatchSearch = searchAirportMatches,
): SearchSuggestionProvider {
  return {
    id: "knowledge-ourairports",
    async searchSuggestions(query: SearchSuggestionQuery): Promise<SearchSuggestionProviderResult> {
      const matches = await search(ctx.log, query.query, query.limit);
      const attribution = ctx.attributionIndex?.getById("ourairports") ?? {
        sourceId: "ourairports",
        name: "OurAirports",
        url: "https://ourairports.com/",
        attributionText: "OurAirports public-domain airport data",
      };
      return {
        suggestions: matches.map(({ record, kind, matchedValue, namespace }) => ({
          id: `oa:${record.ident}`,
          ids: {
            oa: record.ident,
            ...(record.iata ? { iata: record.iata } : {}),
            ...(record.icao ? { icao: record.icao } : {}),
          },
          label: record.name,
          sublabel: [record.municipality, record.isoCountry].filter(Boolean).join(", "),
          coordinates: [record.lng, record.lat],
          type: "poi" as const,
          rawCategory: "aeroway/aerodrome",
          presetIconKey: "maki-airport",
          searchMatch: {
            kind,
            value: matchedValue,
            normalized: normalizeSearchTerm(matchedValue),
            namespace,
          },
          importance:
            record.type === "large_airport" ? 0.9 : record.type === "medium_airport" ? 0.7 : 0.5,
          provider: "knowledge-ourairports",
          contributingProviders: ["knowledge-ourairports"],
        })),
        attributions: matches.length > 0 ? [attribution] : [],
        freshnessSeconds: 3_600,
      };
    },
  };
}

/**
 * Resolve the nearest IATA-coded airports to a coordinate, preferring
 * scheduled-service large/medium airports. Used by the flights feature to
 * prefill the origin/destination airport for a directions endpoint. Searches
 * progressively wider bounding boxes and relaxes the filters only if nothing
 * suitable is found nearby, then re-sorts the candidates by true great-circle
 * distance (bbox query returns importance-ordered, not distance-ordered).
 */
async function findNearestAirports(
  ctx: IntegrationContext,
  lat: number,
  lng: number,
  limit: number,
): Promise<NearestHit[]> {
  const attempts: Array<{ deg: number; types: AirportType[]; scheduledOnly: boolean }> = [
    { deg: 2, types: ["large_airport", "medium_airport"], scheduledOnly: true },
    { deg: 5, types: ["large_airport", "medium_airport"], scheduledOnly: true },
    { deg: 12, types: ["large_airport", "medium_airport"], scheduledOnly: true },
    { deg: 12, types: ["large_airport", "medium_airport", "small_airport"], scheduledOnly: false },
  ];

  for (const attempt of attempts) {
    const recs = await queryAirportsInBbox(ctx.log, {
      west: lng - attempt.deg,
      east: lng + attempt.deg,
      south: lat - attempt.deg,
      north: lat + attempt.deg,
      types: attempt.types,
      scheduledOnly: attempt.scheduledOnly,
      limit: 300,
    });
    const withIata = recs.filter((r) => r.iata);
    if (withIata.length === 0) continue;
    return withIata
      .map((r) => ({ ...recordToHit(r), distanceKm: haversineKm(lat, lng, r.lat, r.lng) }))
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, limit)
      .map((hit) => ({ ...hit, distanceKm: Math.round(hit.distanceKm) }));
  }
  return [];
}

export function setup(ctx: IntegrationContext): void {
  startBackgroundLoad(ctx.log);
  ctx.registerKnowledgeProvider(createOurAirportsSource(ctx.log));
  ctx.registerSearchSuggestionProvider(createOurAirportsSuggestionProvider(ctx));

  // Place-resolver for `oa:` scheme. When the SearchBar / overlay clicks
  // an airport, it navigates to `oa:<ident>` (e.g. `oa:EDDL`). The resolver
  // returns a Place with synthetic `osmTags` so the downstream knowledge
  // pipeline matches the airport via the IATA/ICAO entries it already knows
  // and renders the full runway / frequency / navaid section. This avoids
  // the lossy coordinate → Nominatim reverse-geocode → "maybe-aerodrome"
  // chain that otherwise lands the user on a generic POI panel.
  registerPlaceResolver("oa", async (value) => {
    const code = value.split(":")[0].trim().toUpperCase();
    if (!code) return null;
    const record = await lookupAirportRecord(ctx.log, {
      ident: code,
      iata: code.length === 3 ? code : undefined,
      icao: code.length === 4 ? code : undefined,
    });
    if (!record) return null;

    const osmTags: Record<string, string> = {
      aeroway: record.type === "heliport" ? "heliport" : "aerodrome",
      name: record.name,
    };
    if (record.iata) osmTags.iata = record.iata;
    if (record.icao) osmTags.icao = record.icao;
    if (record.wikipediaLink) {
      const match = record.wikipediaLink.match(/wikipedia\.org\/wiki\/(.+)$/);
      if (match) osmTags.wikipedia = `en:${decodeURIComponent(match[1]).replace(/_/g, " ")}`;
    }

    const place: Place = createPlace({
      primaryScheme: "oa",
      ids: {
        oa: record.ident,
        ...(record.iata ? { iata: record.iata } : {}),
        ...(record.icao ? { icao: record.icao } : {}),
      },
      name: record.name,
      address: [record.municipality, record.isoCountry].filter(Boolean).join(", "),
      city: record.municipality ?? undefined,
      countryCode: record.isoCountry?.toLowerCase() ?? undefined,
      coordinates: [record.lng, record.lat],
      category: "Airport",
      rawCategory: "aeroway/aerodrome",
      website: record.homeLink ?? undefined,
      osmTags,
    });
    return place;
  });

  // GET /search?q=DUS → returns up to N airports matching IATA / ICAO / name /
  // keyword. Used by the SearchBar to surface airports in the autocomplete
  // dropdown alongside geocoder + transit results.
  ctx.registerRoute("GET", "/search", async (req, reply) => {
    const q = (req.query.q ?? "").trim();
    if (q.length < SEARCH_MIN_LEN) {
      reply.header("Cache-Control", "public, max-age=60");
      reply.send({ matches: [] });
      return;
    }
    const parsedLimit = Number.parseInt(req.query.limit ?? "", 10);
    const limit =
      Number.isFinite(parsedLimit) && parsedLimit > 0
        ? Math.min(parsedLimit, SEARCH_MAX_LIMIT)
        : SEARCH_DEFAULT_LIMIT;

    const cacheKey = `search:${limit}:${q.toLowerCase()}`;
    // Cache 1h — daily refresh of the catalog dominates any stale data risk.
    const payload = await ctx.cache.withCache(cacheKey, 60 * 60, async () => {
      const records = await searchAirports(ctx.log, q, limit);
      const matches: SearchHit[] = records.map((r) => ({
        id: r.id,
        ident: r.ident,
        name: r.name,
        type: r.type,
        iata: r.iata,
        icao: r.icao,
        lat: r.lat,
        lng: r.lng,
        municipality: r.municipality,
        isoCountry: r.isoCountry,
        scheduledService: r.scheduledService,
      }));
      return { matches };
    });
    reply.header("Cache-Control", "public, max-age=3600");
    reply.send(payload);
  });

  // GET /nearest?lat=&lng=&limit= → nearest IATA airports to a coordinate,
  // closest first, preferring scheduled-service airports. Powers the flights
  // feature's automatic origin/destination airport prefill.
  ctx.registerRoute("GET", "/nearest", async (req, reply) => {
    const lat = Number.parseFloat(req.query.lat ?? "");
    const lng = Number.parseFloat(req.query.lng ?? "");
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90) {
      reply.status(400).send({ error: "lat and lng must be valid coordinates" });
      return;
    }
    const parsedLimit = Number.parseInt(req.query.limit ?? "", 10);
    const limit =
      Number.isFinite(parsedLimit) && parsedLimit > 0
        ? Math.min(parsedLimit, NEAREST_MAX_LIMIT)
        : NEAREST_DEFAULT_LIMIT;

    const cacheKey = `nearest:${limit}:${lat.toFixed(2)}:${lng.toFixed(2)}`;
    const payload = await ctx.cache.withCache(cacheKey, 60 * 60, async () => {
      const matches = await findNearestAirports(ctx, lat, lng, limit);
      return { matches };
    });
    reply.header("Cache-Control", "public, max-age=3600");
    reply.send(payload);
  });

  ctx.onShutdown(async () => {
    stopBackgroundLoad();
  });
}

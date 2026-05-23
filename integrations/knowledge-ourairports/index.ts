import { type AirportType, createPlace, type Place } from "@openmapx/core";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { lookupAirportRecord, searchAirports } from "@openmapx/ourairports-data";
import { registerPlaceResolver } from "@openmapx/place-ids";
import { startBackgroundLoad, stopBackgroundLoad } from "./data.js";
import { createOurAirportsSource } from "./provider.js";

const SEARCH_MIN_LEN = 2;
const SEARCH_MAX_LIMIT = 20;
const SEARCH_DEFAULT_LIMIT = 8;

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

export function setup(ctx: IntegrationContext): void {
  startBackgroundLoad(ctx.log);
  ctx.registerKnowledgeProvider(createOurAirportsSource(ctx.log));

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
    const cached = await ctx.cache.get<{ matches: SearchHit[] }>(cacheKey);
    if (cached) {
      reply.header("Cache-Control", "public, max-age=3600");
      reply.send(cached);
      return;
    }

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

    const payload = { matches };
    // Cache 1h — daily refresh of the catalog dominates any stale data risk.
    await ctx.cache.set(cacheKey, payload, 60 * 60);
    reply.header("Cache-Control", "public, max-age=3600");
    reply.send(payload);
  });

  ctx.onShutdown(async () => {
    stopBackgroundLoad();
  });
}

import { createHash } from "node:crypto";
import { type AutocompleteResult, setOverpassUrl } from "@openmapx/core";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { registerPlaceResolver } from "@openmapx/place-ids";
import { MemCache } from "./mem-cache.js";
import { getGeocodingProvider, setConfiguredProviderList } from "./orchestrator.js";
import {
  lookupByOsmRef,
  reverseGeocodeCountry,
  setPlaceLookupNominatimUrl,
} from "./place-lookup.js";
import { expandSearchQuery, fetchWithVariants } from "./query-expansion.js";

/** Build a short hash key from a prefix + arbitrary data. */
function hashKey(prefix: string, data: unknown): string {
  const hash = createHash("sha256").update(JSON.stringify(data)).digest("hex").slice(0, 16);
  return `${prefix}:${hash}`;
}

/** Round a number to a fixed number of decimal places. */
function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

const TTL_FORWARD = 86400;
const TTL_REVERSE = 86400;
const TTL_AUTOCOMPLETE = 3600;

// L1 in-memory cache: sub-millisecond reads for hot autocomplete queries.
// Soft TTL 5 min (serve stale + background refresh), hard TTL 2 h (evict).
const MEM_SOFT_MS = 5 * 60_000;
const MEM_HARD_MS = 2 * 3600_000;
const memCache = new MemCache<AutocompleteResult[]>(1000);

export function setup(ctx: IntegrationContext): void {
  setConfiguredProviderList(ctx.config.provider as string | undefined);
  const nominatim = ctx.getRequiredService("nominatim");
  const overpass = ctx.getRequiredService("overpass");
  setPlaceLookupNominatimUrl((ctx.config.nominatimUrl as string | undefined) ?? nominatim?.url);
  if (overpass?.url) setOverpassUrl(overpass.url);

  // OSM primary-id dispatch: when a Place.id arrives as `osm:node/123`,
  // resolve it via Nominatim's OSM-ref detail lookup.
  registerPlaceResolver("osm", async (value, resolverCtx) => {
    const match = value.match(/^(node|way|relation)\/(\d+)/);
    if (!match) return null;
    const [, osmType, osmId] = match;
    return lookupByOsmRef(osmType, osmId, `osm:${value}`, resolverCtx.lang);
  });

  // GET /geocode
  ctx.registerRoute("GET", "/geocode", async (req, reply) => {
    const q = req.query.q;
    const lang = req.query.lang;

    if (!q || typeof q !== "string" || q.trim().length === 0) {
      reply.status(400).send({ error: "Query parameter 'q' is required" });
      return;
    }

    const lat = Number.parseFloat(req.query.lat);
    const lng = Number.parseFloat(req.query.lng);
    const proximity: [number, number] | undefined =
      Number.isFinite(lat) && Number.isFinite(lng) ? [lng, lat] : undefined;

    const effectiveLang = lang ?? "en";
    const expandedQ = expandSearchQuery(q);
    const normalizedQ = expandedQ.trim().toLowerCase();
    // ~1 km rounding so nearby anchors share a cache slot; unbiased queries keep a distinct key.
    const proxKey = proximity ? `${round(proximity[0], 2)},${round(proximity[1], 2)}` : "none";

    try {
      const result = await ctx.cache.withCache(
        hashKey("cache:geocode", { q: normalizedQ, lang: effectiveLang, prox: proxKey }),
        TTL_FORWARD,
        () =>
          fetchWithVariants(q, (v) =>
            getGeocodingProvider(ctx).geocode(v, effectiveLang, proximity),
          ),
      );
      reply.header("Cache-Control", "public, max-age=86400");
      reply.send(result);
    } catch (err) {
      ctx.log.error("geocode upstream failed", err);
      reply.header("Cache-Control", "no-cache");
      reply.send([]);
    }
  });

  // GET /geocode/reverse
  ctx.registerRoute("GET", "/geocode/reverse", async (req, reply) => {
    const lat = Number.parseFloat(req.query.lat);
    const lng = Number.parseFloat(req.query.lng);
    const lang = req.query.lang;

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      reply.status(400).send({ error: "lat and lng must be valid numbers" });
      return;
    }

    // Round to 4dp (~11m) to maximise cache hits for nearby queries
    const effectiveLang = lang ?? "en";
    const key = `cache:geocode:rev:${round(lat, 4)}:${round(lng, 4)}:${effectiveLang}`;

    try {
      const result = await ctx.cache.withCache(key, TTL_REVERSE, () =>
        getGeocodingProvider(ctx).reverseGeocode(lat, lng, effectiveLang),
      );
      reply.header("Cache-Control", "public, max-age=86400");
      reply.send(result);
    } catch (err) {
      ctx.log.error("reverse geocode upstream failed", err);
      reply.header("Cache-Control", "no-cache");
      reply.send(null);
    }
  });

  // GET /geocode/country — coarse coordinate → lowercase ISO 3166-1 alpha-2
  // country code. Used by region-aware integrations (e.g. food-delivery) when a
  // place carries no countryCode of its own. Country-level zoom, cached 24h.
  ctx.registerRoute("GET", "/geocode/country", async (req, reply) => {
    const lat = Number.parseFloat(req.query.lat);
    const lng = Number.parseFloat(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      reply.status(400).send({ error: "lat and lng must be valid numbers" });
      return;
    }
    const countryCode = await reverseGeocodeCountry(lat, lng);
    reply.header("Cache-Control", "public, max-age=86400");
    reply.send({ countryCode: countryCode ?? null });
  });

  // GET /autocomplete
  ctx.registerRoute("GET", "/autocomplete", async (req, reply) => {
    const q = req.query.q;
    const lang = req.query.lang;

    if (!q || typeof q !== "string" || q.trim().length === 0) {
      reply.status(400).send({ error: "Query parameter 'q' is required" });
      return;
    }

    const effectiveLang = lang ?? "en";
    const expandedQ = expandSearchQuery(q);
    // Normalize for cache key so "Hamburg"/"hamburg" and "Hbf"/"Hauptbahnhof" share a slot
    const normalizedQ = expandedQ.trim().toLowerCase();
    const key = hashKey("cache:autocomplete", { q: normalizedQ, lang: effectiveLang });

    // L1: in-memory check (sub-millisecond)
    const mem = memCache.get(key);
    if (mem) {
      if (mem.stale) {
        // Stale-while-revalidate: serve immediately, refresh in background
        void ctx.cache
          .withCache(key, TTL_AUTOCOMPLETE, () =>
            fetchWithVariants(q, (v) => getGeocodingProvider(ctx).autocomplete(v, effectiveLang)),
          )
          .then((fresh) => memCache.set(key, fresh, MEM_SOFT_MS, MEM_HARD_MS))
          .catch(() => {});
      }
      reply.header("Cache-Control", "public, max-age=3600");
      reply.send(mem.data);
      return;
    }

    // L2: Redis + upstream -- gracefully degrade on failure
    try {
      const result = await ctx.cache.withCache(key, TTL_AUTOCOMPLETE, () =>
        fetchWithVariants(q, (v) => getGeocodingProvider(ctx).autocomplete(v, effectiveLang)),
      );
      memCache.set(key, result, MEM_SOFT_MS, MEM_HARD_MS);
      reply.header("Cache-Control", "public, max-age=3600");
      reply.send(result);
    } catch (err) {
      ctx.log.error("autocomplete upstream failed, trying stale cache", err);
      // Try stale Redis data before giving up
      const stale = await ctx.cache.get<AutocompleteResult[]>(key);
      if (stale) {
        memCache.set(key, stale, MEM_SOFT_MS, MEM_HARD_MS);
        reply.header("Cache-Control", "public, max-age=60");
        reply.send(stale);
        return;
      }
      // No cached data at all -- return empty instead of 500
      reply.header("Cache-Control", "no-cache");
      reply.send([]);
    }
  });
}

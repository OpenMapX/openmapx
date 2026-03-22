import type { AutocompleteResult } from "@openmapx/core";
import type { FastifyPluginAsync } from "fastify";
import { getGeocodingProvider } from "../services/geocoding.factory";
import { cacheGet, hashKey, MemCache, TTL, withCache } from "../utils/cache.js";
import { expandSearchQuery, fetchWithVariants } from "../utils/query-expansion.js";

// L1 in-memory cache: sub-millisecond reads for hot autocomplete queries.
// Soft TTL 5 min (serve stale + background refresh), hard TTL 2 h (evict).
const MEM_SOFT_MS = 5 * 60_000;
const MEM_HARD_MS = 2 * 3600_000;
const memCache = new MemCache<AutocompleteResult[]>(1000);

export const autocompleteRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Querystring: { q: string; lang?: string } }>("/autocomplete", {
    schema: {
      querystring: {
        type: "object",
        required: ["q"],
        properties: {
          q: { type: "string", minLength: 1 },
          lang: { type: "string" },
        },
      },
    },
    handler: async (req, reply) => {
      const { q, lang } = req.query;
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
          void withCache(key, TTL.geocoding.autocomplete, () =>
            fetchWithVariants(q, (v) => getGeocodingProvider().autocomplete(v, effectiveLang)),
          )
            .then((fresh) => memCache.set(key, fresh, MEM_SOFT_MS, MEM_HARD_MS))
            .catch(() => {});
        }
        reply.header("Cache-Control", "public, max-age=3600");
        return mem.data;
      }

      // L2: Redis + upstream — gracefully degrade on failure
      try {
        const result = await withCache(key, TTL.geocoding.autocomplete, () =>
          fetchWithVariants(q, (v) => getGeocodingProvider().autocomplete(v, effectiveLang)),
        );
        memCache.set(key, result, MEM_SOFT_MS, MEM_HARD_MS);
        reply.header("Cache-Control", "public, max-age=3600");
        return result;
      } catch (err) {
        req.log.error(err, "autocomplete upstream failed, trying stale cache");
        // Try stale Redis data before giving up
        const stale = await cacheGet<AutocompleteResult[]>(key);
        if (stale) {
          memCache.set(key, stale, MEM_SOFT_MS, MEM_HARD_MS);
          reply.header("Cache-Control", "public, max-age=60");
          return stale;
        }
        // No cached data at all — return empty instead of 500
        reply.header("Cache-Control", "no-cache");
        return [];
      }
    },
  });
};

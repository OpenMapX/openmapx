import { LRUCache } from "lru-cache";
import type { MobilityHttpTransport } from "./json-transport.js";

const DEFAULT_NOMINATIM_URL = process.env.NOMINATIM_URL ?? "https://nominatim.openstreetmap.org";
const CITY_NAME_TTL_MS = 24 * 60 * 60 * 1000;

export interface NominatimClient {
  clearCache(): void;
  reverseGeocodeCity(lat: number, lng: number, lang?: string): Promise<string | null>;
}

export function createNominatimClient(options: {
  transport: MobilityHttpTransport;
  url?: string;
  /** Runtime updates availability and calls clearCache on each invalidation. */
  isCacheAvailable?: () => boolean;
}): NominatimClient {
  const trimmed = options.url?.trim();
  const baseUrl = trimmed && trimmed.length > 0 ? trimmed : DEFAULT_NOMINATIM_URL;
  // Entry budget, rather than a memory-byte estimate.
  const cityNameCache = new LRUCache<string, { city: string | null; expiresAt: number }>({
    max: 4096,
    ttl: CITY_NAME_TTL_MS,
    updateAgeOnGet: false,
  });
  const isCacheAvailable = options.isCacheAvailable ?? (() => true);
  let generation = 0;

  return {
    clearCache() {
      generation++;
      cityNameCache.clear();
    },
    async reverseGeocodeCity(lat, lng, lang) {
      const effectiveLang = lang ?? "en";
      const key = `${Math.round(lat * 10) / 10},${Math.round(lng * 10) / 10}:${effectiveLang}`;
      const startedGeneration = generation;
      const cached = isCacheAvailable() ? cityNameCache.get(key) : undefined;
      // Keep the strict deadline: lru-cache may still return an entry at exactly its TTL.
      if (cached && cached.expiresAt > Date.now()) return cached.city;

      try {
        const url = new URL(`${baseUrl}/reverse`);
        url.searchParams.set("lat", String(lat));
        url.searchParams.set("lon", String(lng));
        url.searchParams.set("format", "jsonv2");
        url.searchParams.set("addressdetails", "1");
        url.searchParams.set("zoom", "10");
        url.searchParams.set("accept-language", effectiveLang);

        const result = await options.transport.fetchJson<{
          address?: { city?: string; town?: string; village?: string };
        }>(url.toString(), {
          headers: { "User-Agent": options.transport.userAgent },
          timeoutMs: 5_000,
        });
        const city =
          result?.address?.city ?? result?.address?.town ?? result?.address?.village ?? null;

        if (generation === startedGeneration && isCacheAvailable()) {
          cityNameCache.set(key, { city, expiresAt: Date.now() + CITY_NAME_TTL_MS });
        }
        return city;
      } catch {
        return null;
      }
    },
  };
}

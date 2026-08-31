import type { MobilityHttpTransport } from "./json-transport.js";

const DEFAULT_NOMINATIM_URL = process.env.NOMINATIM_URL ?? "https://nominatim.openstreetmap.org";
const CITY_NAME_TTL_MS = 24 * 60 * 60 * 1000;

export interface NominatimClient {
  reverseGeocodeCity(lat: number, lng: number, lang?: string): Promise<string | null>;
}

export function createNominatimClient(options: {
  transport: MobilityHttpTransport;
  url?: string;
}): NominatimClient {
  const trimmed = options.url?.trim();
  const baseUrl = trimmed && trimmed.length > 0 ? trimmed : DEFAULT_NOMINATIM_URL;
  const cityNameCache = new Map<string, { city: string | null; expiresAt: number }>();

  return {
    async reverseGeocodeCity(lat, lng, lang) {
      const effectiveLang = lang ?? "en";
      const key = `${Math.round(lat * 10) / 10},${Math.round(lng * 10) / 10}:${effectiveLang}`;
      const cached = cityNameCache.get(key);
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

        cityNameCache.set(key, { city, expiresAt: Date.now() + CITY_NAME_TTL_MS });
        return city;
      } catch {
        return null;
      }
    },
  };
}

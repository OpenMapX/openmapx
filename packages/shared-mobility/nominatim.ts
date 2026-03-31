const NOMINATIM_URL = process.env.NOMINATIM_URL ?? "https://nominatim.openstreetmap.org";

const cityNameCache = new Map<string, { city: string | null; expiresAt: number }>();
const CITY_NAME_TTL_MS = 24 * 60 * 60 * 1000;

export async function reverseGeocodeCity(
  lat: number,
  lng: number,
  lang?: string,
): Promise<string | null> {
  const effectiveLang = lang ?? "en";
  const key = `${Math.round(lat * 10) / 10},${Math.round(lng * 10) / 10}:${effectiveLang}`;
  const cached = cityNameCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.city;

  try {
    const url = new URL(`${NOMINATIM_URL}/reverse`);
    url.searchParams.set("lat", String(lat));
    url.searchParams.set("lon", String(lng));
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("zoom", "10");
    url.searchParams.set("accept-language", effectiveLang);

    const res = await fetch(url.toString(), {
      headers: { "User-Agent": "OpenMapX/1.0" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;

    const result = (await res.json()) as {
      address?: { city?: string; town?: string; village?: string };
    };
    const city = result?.address?.city ?? result?.address?.town ?? result?.address?.village ?? null;

    cityNameCache.set(key, { city, expiresAt: Date.now() + CITY_NAME_TTL_MS });
    return city;
  } catch {
    return null;
  }
}

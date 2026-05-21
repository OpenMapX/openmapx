import { USER_AGENT } from "@openmapx/core";
import type { CacheClient, IntegrationContext } from "@openmapx/integration-framework";

const OPENAQ_BASE = "https://api.openaq.org/v3";
const PM25_PARAM_ID = 2;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_LATEST_FETCHES = 100;
const CONCURRENCY = 5;
const LOCATION_CACHE_TTL = 900; // 15 minutes
const STATION_CACHE_TTL = 900;

interface OpenAQLatest {
  datetime: { utc: string; local: string };
  value: number;
  coordinates: { latitude: number; longitude: number } | null;
  sensorsId: number;
  locationsId: number;
}

interface OpenAQLocationLicense {
  id: number;
  name: string;
  attribution: { name: string; url: string } | null;
}

interface OpenAQLocationSensor {
  id: number;
  name: string;
  parameter: { id: number; name: string; units: string; displayName: string | null };
}

interface OpenAQLocationInstrument {
  id: number;
  name: string;
  sensors: OpenAQLocationSensor[];
}

interface OpenAQLocation {
  id: number;
  name: string;
  locality: string | null;
  coordinates: { latitude: number; longitude: number };
  country: { code: string; name: string } | null;
  provider: { id: number; name: string } | null;
  owner: { id: number; name: string } | null;
  instruments: OpenAQLocationInstrument[];
  licenses: OpenAQLocationLicense[];
}

interface OpenAQResponse<T> {
  meta: { found: number; limit: number; page: number };
  results: T[];
}

interface AirQualityStation {
  id: number;
  name: string;
  lat: number;
  lng: number;
  aqi: number;
  pm25: number;
  lastUpdated: string;
  attribution: { name: string; url: string } | null;
  license: string | null;
}

function pm25ToAqi(pm: number): number {
  const bp: [number, number, number, number][] = [
    [0, 12.0, 0, 50],
    [12.1, 35.4, 51, 100],
    [35.5, 55.4, 101, 150],
    [55.5, 150.4, 151, 200],
    [150.5, 250.4, 201, 300],
    [250.5, 500.4, 301, 500],
  ];
  if (pm < 0) return 0;
  for (const [cLow, cHigh, iLow, iHigh] of bp) {
    if (pm <= cHigh) return Math.round(((iHigh - iLow) / (cHigh - cLow)) * (pm - cLow) + iLow);
  }
  return 500;
}

interface FetchResult<T> {
  data: T | null;
  rateLimitRemaining: number | null;
  rateLimitReset: number | null;
  status: number;
}

async function fetchOpenAQ<T>(path: string, apiKey: string): Promise<FetchResult<T>> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(`${OPENAQ_BASE}${path}`, {
      headers: {
        "X-API-Key": apiKey,
        "User-Agent": USER_AGENT,
      },
      signal: controller.signal,
    });
    clearTimeout(timer);

    const rem = res.headers.get("x-ratelimit-remaining");
    const rst = res.headers.get("x-ratelimit-reset");

    return {
      data: res.ok ? ((await res.json()) as T) : null,
      rateLimitRemaining: rem ? Number.parseInt(rem, 10) : null,
      rateLimitReset: rst ? Number.parseInt(rst, 10) : null,
      status: res.status,
    };
  } catch {
    return { data: null, rateLimitRemaining: null, rateLimitReset: null, status: 0 };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForReset(result: FetchResult<unknown>, retries: number): Promise<boolean> {
  if (result.status !== 429 || retries >= 2) return false;
  const resetAt = result.rateLimitReset;
  const waitMs = resetAt ? Math.max(0, resetAt * 1000 - Date.now()) + 1000 : 60_000;
  await sleep(Math.min(waitMs, 120_000));
  return true;
}

interface LocationMeta {
  id: number;
  name: string;
  lat: number;
  lng: number;
  attribution: { name: string; url: string } | null;
  license: string | null;
}

function locationCacheKey(south: number, west: number, north: number, east: number): string {
  const r = (n: number) => (Math.round(n * 10) / 10).toFixed(1);
  return `loc:${r(south)},${r(west)},${r(north)},${r(east)}`;
}

async function fetchLocationsInBbox(
  apiKey: string,
  cache: CacheClient,
  south: number,
  west: number,
  north: number,
  east: number,
): Promise<LocationMeta[]> {
  const cacheKey = locationCacheKey(south, west, north, east);

  const cached = await cache.get<LocationMeta[]>(cacheKey);
  if (cached) return cached;

  const locations: LocationMeta[] = [];
  let page = 1;
  const limit = 200;
  const maxPages = 5;

  while (page <= maxPages) {
    let result: FetchResult<OpenAQResponse<OpenAQLocation>>;
    let retries = 0;

    do {
      result = await fetchOpenAQ<OpenAQResponse<OpenAQLocation>>(
        `/locations?bbox=${west},${south},${east},${north}&parameters_id=${PM25_PARAM_ID}&mobile=false&limit=${limit}&page=${page}`,
        apiKey,
      );
    } while (await waitForReset(result, retries++));

    if (!result.data?.results?.length) break;

    for (const loc of result.data.results) {
      const licenseEntry = loc.licenses.find((l) => l.attribution);
      locations.push({
        id: loc.id,
        name: loc.name,
        lat: loc.coordinates.latitude,
        lng: loc.coordinates.longitude,
        attribution: licenseEntry?.attribution ?? null,
        license: licenseEntry?.name ?? null,
      });
    }

    if (result.data.results.length < limit) break;
    await sleep(1000);
    page++;
  }

  if (locations.length > 0) {
    await cache.set(cacheKey, locations, LOCATION_CACHE_TTL);
  }

  return locations;
}

interface StationValue {
  pm25: number;
  aqi: number;
  lastUpdated: string;
}

async function fetchLatestForLocation(
  apiKey: string,
  cache: CacheClient,
  locationId: number,
): Promise<StationValue | null> {
  const valCacheKey = `val:${locationId}`;

  const cached = await cache.get<StationValue>(valCacheKey);
  if (cached) return cached;

  let result: FetchResult<OpenAQResponse<OpenAQLatest>>;
  let retries = 0;

  do {
    result = await fetchOpenAQ<OpenAQResponse<OpenAQLatest>>(
      `/locations/${locationId}/latest`,
      apiKey,
    );
  } while (await waitForReset(result, retries++));

  if (!result.data?.results?.length) return null;

  for (const r of result.data.results) {
    if (r.value >= 0) {
      const value: StationValue = {
        pm25: r.value,
        aqi: pm25ToAqi(r.value),
        lastUpdated: r.datetime.utc,
      };
      await cache.set(valCacheKey, value, STATION_CACHE_TTL);
      return value;
    }
  }

  return null;
}

async function resolveLatestValues(
  apiKey: string,
  cache: CacheClient,
  locations: LocationMeta[],
): Promise<Map<number, StationValue>> {
  const result = new Map<number, StationValue>();
  const uncached: LocationMeta[] = [];

  for (const loc of locations) {
    const cached = await cache.get<StationValue>(`val:${loc.id}`);
    if (cached) {
      result.set(loc.id, cached);
    } else {
      uncached.push(loc);
    }
  }

  const toFetch = uncached.slice(0, MAX_LATEST_FETCHES);

  for (let i = 0; i < toFetch.length; i += CONCURRENCY) {
    const batch = toFetch.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.allSettled(
      batch.map((loc) => fetchLatestForLocation(apiKey, cache, loc.id)),
    );

    for (let j = 0; j < batch.length; j++) {
      const r = batchResults[j];
      if (r.status === "fulfilled" && r.value) {
        result.set(batch[j].id, r.value);
      }
    }

    if (i + CONCURRENCY < toFetch.length) {
      await sleep(1500);
    }
  }

  return result;
}

export function setup(ctx: IntegrationContext): void {
  ctx.registerRoute("GET", "/air-quality/stations", async (req, reply) => {
    const apiKey = ctx.config.apiKey as string | undefined;
    if (!apiKey) {
      reply.status(503).send({ message: "Air quality is not configured" });
      return;
    }

    const south = Number.parseFloat(req.query.south);
    const west = Number.parseFloat(req.query.west);
    const north = Number.parseFloat(req.query.north);
    const east = Number.parseFloat(req.query.east);

    if ([south, west, north, east].some(Number.isNaN)) {
      reply.status(400).send({ message: "Invalid bbox coordinates" });
      return;
    }

    const MAX_BBOX_SPAN = 15;
    if (north - south > MAX_BBOX_SPAN || east - west > MAX_BBOX_SPAN) {
      reply.status(400).send({ message: "Bounding box too large" });
      return;
    }

    const locations = await fetchLocationsInBbox(apiKey, ctx.cache, south, west, north, east);
    const values = await resolveLatestValues(apiKey, ctx.cache, locations);

    const stations: AirQualityStation[] = [];
    for (const loc of locations) {
      const val = values.get(loc.id);
      if (!val) continue;
      stations.push({
        id: loc.id,
        name: loc.name,
        lat: loc.lat,
        lng: loc.lng,
        aqi: val.aqi,
        pm25: val.pm25,
        lastUpdated: val.lastUpdated,
        attribution: loc.attribution,
        license: loc.license,
      });
    }

    reply.send(stations);
  });
}

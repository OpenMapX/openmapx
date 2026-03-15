import type { FastifyPluginAsync } from "fastify";
import { redis } from "../redis.js";

const OPENAQ_BASE = "https://api.openaq.org/v3";
/** PM2.5 parameter ID in OpenAQ v3. */
const PM25_PARAM_ID = 2;
const FETCH_TIMEOUT_MS = 15_000;

/** TTL for per-station latest values (individual Redis keys). */
const STATION_CACHE_TTL_S = 3600;
/** TTL for location metadata per viewport. */
const LOCATION_CACHE_TTL_S = 3600;
/** Max stations to fetch latest values for per request. */
const MAX_LATEST_FETCHES = 100;
/** Concurrent latest-value fetches (keep well under 60 req/min). */
const CONCURRENCY = 5;

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

export interface AirQualityStation {
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
        "User-Agent": "OpenMapX/1.0 (https://github.com/openmapx)",
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

/** Wait until rate limit resets. Returns false if retries exhausted. */
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

/** Round to 1 decimal (~11km grid) for cache key stability. */
function locationCacheKey(south: number, west: number, north: number, east: number): string {
  const r = (n: number) => (Math.round(n * 10) / 10).toFixed(1);
  return `cache:aq:loc:${r(south)},${r(west)},${r(north)},${r(east)}`;
}

async function fetchLocationsInBbox(
  apiKey: string,
  south: number,
  west: number,
  north: number,
  east: number,
): Promise<LocationMeta[]> {
  const cacheKey = locationCacheKey(south, west, north, east);

  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) return JSON.parse(cached) as LocationMeta[];
    } catch {
      // Fall through
    }
  }

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

  if (redis && locations.length > 0) {
    try {
      await redis.set(cacheKey, JSON.stringify(locations), "EX", LOCATION_CACHE_TTL_S);
    } catch {
      // Silent
    }
  }

  return locations;
}

interface StationValue {
  pm25: number;
  aqi: number;
  lastUpdated: string;
}

function stationCacheKey(locationId: number): string {
  return `cache:aq:val:${locationId}`;
}

async function getCachedValue(locationId: number): Promise<StationValue | null> {
  if (!redis) return null;
  try {
    const cached = await redis.get(stationCacheKey(locationId));
    return cached ? (JSON.parse(cached) as StationValue) : null;
  } catch {
    return null;
  }
}

async function cacheValue(locationId: number, value: StationValue): Promise<void> {
  if (!redis) return;
  try {
    await redis.set(stationCacheKey(locationId), JSON.stringify(value), "EX", STATION_CACHE_TTL_S);
  } catch {
    // Silent
  }
}

async function fetchLatestForLocation(
  apiKey: string,
  locationId: number,
): Promise<StationValue | null> {
  let result: FetchResult<OpenAQResponse<OpenAQLatest>>;
  let retries = 0;

  do {
    result = await fetchOpenAQ<OpenAQResponse<OpenAQLatest>>(
      `/locations/${locationId}/latest`,
      apiKey,
    );
  } while (await waitForReset(result, retries++));

  if (!result.data?.results?.length) return null;

  // Find the PM2.5 reading (location may have multiple sensors/parameters)
  // The latest endpoint returns all sensors — pick the one with sensorsId matching PM2.5
  // Since we filtered locations by parameters_id=2, at least one sensor should be PM2.5
  // Use the first positive value
  for (const r of result.data.results) {
    if (r.value >= 0) {
      const value: StationValue = {
        pm25: r.value,
        aqi: pm25ToAqi(r.value),
        lastUpdated: r.datetime.utc,
      };
      await cacheValue(locationId, value);
      return value;
    }
  }

  return null;
}

/**
 * Fetch latest values for multiple locations with concurrency limiting.
 * Checks per-station cache first, only fetches uncached ones.
 */
async function resolveLatestValues(
  apiKey: string,
  locations: LocationMeta[],
): Promise<Map<number, StationValue>> {
  const result = new Map<number, StationValue>();
  const uncached: LocationMeta[] = [];

  // Phase 1: check cache for all locations
  for (const loc of locations) {
    const cached = await getCachedValue(loc.id);
    if (cached) {
      result.set(loc.id, cached);
    } else {
      uncached.push(loc);
    }
  }

  // Phase 2: fetch uncached, limited to MAX_LATEST_FETCHES with CONCURRENCY
  const toFetch = uncached.slice(0, MAX_LATEST_FETCHES);

  for (let i = 0; i < toFetch.length; i += CONCURRENCY) {
    const batch = toFetch.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.allSettled(
      batch.map((loc) => fetchLatestForLocation(apiKey, loc.id)),
    );

    for (let j = 0; j < batch.length; j++) {
      const r = batchResults[j];
      if (r.status === "fulfilled" && r.value) {
        result.set(batch[j].id, r.value);
      }
    }

    // Pace between batches (5 reqs per second = 300/min capacity, well under 60 req/min with this)
    if (i + CONCURRENCY < toFetch.length) {
      await sleep(1500);
    }
  }

  return result;
}

export const airQualityRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get<{
    Querystring: { south: string; west: string; north: string; east: string };
  }>("/air-quality/stations", {
    schema: {
      querystring: {
        type: "object",
        required: ["south", "west", "north", "east"],
        properties: {
          south: { type: "string" },
          west: { type: "string" },
          north: { type: "string" },
          east: { type: "string" },
        },
      },
    },
    handler: async (req, reply) => {
      const apiKey = process.env.OPENAQ_API_KEY;
      if (!apiKey) {
        return reply.status(503).send({ message: "Air quality is not configured" });
      }

      const south = Number.parseFloat(req.query.south);
      const west = Number.parseFloat(req.query.west);
      const north = Number.parseFloat(req.query.north);
      const east = Number.parseFloat(req.query.east);

      if ([south, west, north, east].some(Number.isNaN)) {
        return reply.status(400).send({ message: "Invalid bbox coordinates" });
      }

      // 1. Get locations in viewport (with license/attribution metadata)
      const locations = await fetchLocationsInBbox(apiKey, south, west, north, east);

      // 2. Resolve latest PM2.5 values (from per-station cache or API)
      const values = await resolveLatestValues(apiKey, locations);

      // 3. Join: only include stations that have a value
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

      reply.header("Cache-Control", "public, max-age=1800, s-maxage=1800");
      return stations;
    },
  });
};

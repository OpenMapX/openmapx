import type { IntegrationContext } from "@openmapx/integration-framework";

const USGS_FEED_BASE = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary";
const FETCH_TIMEOUT_MS = 15_000;

const _REFRESH_INTERVAL: Record<string, number> = {
  hour: 60_000,
  day: 120_000,
  week: 300_000,
  month: 600_000,
};

const CACHE_TTL: Record<string, number> = {
  hour: 60,
  day: 120,
  week: 300,
  month: 600,
};

interface USGSFeature {
  type: "Feature";
  geometry: {
    type: "Point";
    coordinates: [number, number, number];
  };
  properties: {
    mag: number | null;
    place: string | null;
    time: number;
    updated: number;
    url: string;
    detail: string;
    felt: number | null;
    cdi: number | null;
    mmi: number | null;
    alert: string | null;
    status: string;
    tsunami: number;
    sig: number;
    net: string;
    code: string;
    magType: string;
    type: string;
    title: string;
  };
}

interface USGSFeatureCollection {
  type: "FeatureCollection";
  metadata: { generated: number; url: string; title: string; count: number };
  features: USGSFeature[];
}

function magnitudeToThreshold(minMagnitude: number): string {
  if (minMagnitude >= 4.5) return "4.5";
  if (minMagnitude >= 2.5) return "2.5";
  if (minMagnitude >= 1.0) return "1.0";
  return "all";
}

function buildFeedUrl(timeRange: string, threshold: string): string {
  return `${USGS_FEED_BASE}/${threshold}_${timeRange}.geojson`;
}

function depthCategory(depth: number): string {
  if (depth < 70) return "shallow";
  if (depth < 300) return "intermediate";
  return "deep";
}

function magLabel(mag: number): string {
  if (mag < 2.0) return "Micro";
  if (mag < 4.0) return "Minor";
  if (mag < 5.0) return "Light";
  if (mag < 6.0) return "Moderate";
  if (mag < 7.0) return "Strong";
  if (mag < 8.0) return "Major";
  return "Great";
}

function ageCategory(ageMs: number): string {
  if (ageMs < 3_600_000) return "recent";
  if (ageMs < 86_400_000) return "today";
  if (ageMs < 604_800_000) return "this_week";
  return "older";
}

function enrichFeatures(fc: USGSFeatureCollection): USGSFeatureCollection {
  const now = Date.now();
  return {
    ...fc,
    features: fc.features.map((f) => {
      const depth = Math.max(0, f.geometry.coordinates[2] ?? 0);
      const mag = f.properties.mag ?? 0;
      const age = now - f.properties.time;
      return {
        ...f,
        properties: {
          ...f.properties,
          mag,
          depth,
          depthCategory: depthCategory(depth),
          magLabel: magLabel(mag),
          ageMs: age,
          ageCategory: ageCategory(age),
        },
      };
    }),
  };
}

export function setup(ctx: IntegrationContext): void {
  ctx.registerRoute("GET", "/earthquakes", async (req, reply) => {
    const timeRange = req.query.timeRange ?? "week";
    const minMagnitude = Number.parseFloat(req.query.minMagnitude ?? "2.5");

    if (!["hour", "day", "week", "month"].includes(timeRange)) {
      reply.status(400).send({ message: "Invalid timeRange" });
      return;
    }
    if (Number.isNaN(minMagnitude)) {
      reply.status(400).send({ message: "Invalid minMagnitude" });
      return;
    }

    const threshold = magnitudeToThreshold(minMagnitude);
    const cacheKey = `eq:${timeRange}:${threshold}`;
    const ttl = CACHE_TTL[timeRange] ?? 300;

    try {
      // Check cache first
      const cached = await ctx.cache.get<USGSFeatureCollection>(cacheKey);
      if (cached) {
        reply.send(enrichFeatures(cached));
        return;
      }

      // Fetch from USGS
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      const res = await fetch(buildFeedUrl(timeRange, threshold), {
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        ctx.log.warn(`USGS feed returned ${res.status}`);
        reply.status(503).send({ message: "Earthquake data temporarily unavailable" });
        return;
      }

      const raw = (await res.json()) as USGSFeatureCollection;
      await ctx.cache.set(cacheKey, raw, ttl);

      reply.send(enrichFeatures(raw));
    } catch (err) {
      ctx.log.error("Failed to fetch USGS feed", err);

      // Try stale cache as fallback
      const stale = await ctx.cache.get<USGSFeatureCollection>(cacheKey);
      if (stale) {
        reply.send(enrichFeatures(stale));
        return;
      }

      reply.status(503).send({ message: "Earthquake data temporarily unavailable" });
    }
  });
}

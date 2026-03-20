import type { FastifyPluginAsync } from "fastify";
import { TTL, withCacheStatus } from "../utils/cache.js";

const USGS_FEED_BASE = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary";
const FETCH_TIMEOUT_MS = 15_000;

const REFRESH_INTERVAL: Record<string, number> = {
  hour: 60_000,
  day: 120_000,
  week: 300_000,
  month: 600_000,
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

export const earthquakeRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get<{
    Querystring: { timeRange?: string; minMagnitude?: string };
  }>("/earthquakes", {
    schema: {
      querystring: {
        type: "object",
        properties: {
          timeRange: { type: "string" },
          minMagnitude: { type: "string" },
        },
      },
    },
    handler: async (req, reply) => {
      const timeRange = req.query.timeRange ?? "week";
      const minMagnitude = Number.parseFloat(req.query.minMagnitude ?? "2.5");

      if (!["hour", "day", "week", "month"].includes(timeRange)) {
        return reply.status(400).send({ message: "Invalid timeRange" });
      }
      if (Number.isNaN(minMagnitude)) {
        return reply.status(400).send({ message: "Invalid minMagnitude" });
      }

      const threshold = magnitudeToThreshold(minMagnitude);
      const cacheKey = `cache:eq:${timeRange}:${threshold}`;
      const ttl = TTL.earthquakes[timeRange as keyof typeof TTL.earthquakes] ?? 300;

      try {
        const { data, status } = await withCacheStatus(
          cacheKey,
          ttl,
          async () => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
            const res = await fetch(buildFeedUrl(timeRange, threshold), {
              signal: controller.signal,
            });
            clearTimeout(timer);

            if (!res.ok) {
              fastify.log.warn(`USGS feed returned ${res.status}`);
              throw new Error("USGS feed unavailable");
            }

            const raw = (await res.json()) as USGSFeatureCollection;
            return raw;
          },
          { staleOnError: true },
        );

        reply.header("Cache-Control", `public, max-age=${ttl}`);
        reply.header("X-Cache", status);
        reply.header("X-Refresh-Interval", String(REFRESH_INTERVAL[timeRange] ?? 300_000));
        return enrichFeatures(data);
      } catch (err) {
        fastify.log.error(err, "Failed to fetch USGS feed");
        return reply.status(503).send({ message: "Earthquake data temporarily unavailable" });
      }
    },
  });
};

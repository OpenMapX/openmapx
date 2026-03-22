import type { FastifyPluginAsync } from "fastify";
import { TTL, withCacheStatus } from "../utils/cache.js";

const FIRMS_BASE = "https://firms.modaps.eosdis.nasa.gov/api/area/csv";
const FETCH_TIMEOUT_MS = 30_000;

const REFRESH_INTERVAL: Record<number, number> = {
  1: 300_000,
  2: 600_000,
  3: 900_000,
};

interface FireFeature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: {
    latitude: number;
    longitude: number;
    brightness: number;
    frp: number;
    confidence: string;
    satellite: string;
    acqDate: string;
    acqTime: string;
    dayNight: string;
    ageMs: number;
    source: string;
  };
}

interface FireFeatureCollection {
  type: "FeatureCollection";
  features: FireFeature[];
}

function parseAcqDateTime(date: string, time: string): number {
  // date: "YYYY-MM-DD", time: "HHMM"
  const h = time.padStart(4, "0").slice(0, 2);
  const m = time.padStart(4, "0").slice(2, 4);
  return new Date(`${date}T${h}:${m}:00Z`).getTime();
}

function csvToGeoJSON(csv: string, source: string): FireFeatureCollection {
  const lines = csv.trim().split("\n");
  if (lines.length < 2) return { type: "FeatureCollection", features: [] };

  const headers = lines[0].split(",").map((h) => h.trim());
  const now = Date.now();
  const features: FireFeature[] = [];

  const latIdx = headers.indexOf("latitude");
  const lngIdx = headers.indexOf("longitude");
  const dateIdx = headers.indexOf("acq_date");
  const timeIdx = headers.indexOf("acq_time");
  const confIdx = headers.indexOf("confidence");
  const satIdx = headers.indexOf("satellite");
  const frpIdx = headers.indexOf("frp");
  const dnIdx = headers.indexOf("daynight");
  // VIIRS: bright_ti4, MODIS: brightness
  const brightIdx =
    headers.indexOf("bright_ti4") !== -1
      ? headers.indexOf("bright_ti4")
      : headers.indexOf("brightness");

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    if (cols.length < headers.length) continue;

    const lat = Number.parseFloat(cols[latIdx]);
    const lng = Number.parseFloat(cols[lngIdx]);
    if (Number.isNaN(lat) || Number.isNaN(lng)) continue;

    const confidence = cols[confIdx]?.trim() ?? "";
    // Filter low-confidence detections
    if (source.startsWith("VIIRS")) {
      if (confidence === "low" || confidence === "l") continue;
    } else {
      const confNum = Number.parseInt(confidence, 10);
      if (!Number.isNaN(confNum) && confNum < 50) continue;
    }

    const acqDate = cols[dateIdx]?.trim() ?? "";
    const acqTime = cols[timeIdx]?.trim() ?? "";
    const acqMs = parseAcqDateTime(acqDate, acqTime);
    const frp = Number.parseFloat(cols[frpIdx] ?? "0") || 0;
    const brightness = Number.parseFloat(cols[brightIdx] ?? "0") || 0;

    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [lng, lat] },
      properties: {
        latitude: lat,
        longitude: lng,
        brightness,
        frp,
        confidence,
        satellite: cols[satIdx]?.trim() ?? "",
        acqDate,
        acqTime,
        dayNight: cols[dnIdx]?.trim() ?? "",
        ageMs: now - acqMs,
        source,
      },
    });
  }

  return { type: "FeatureCollection", features };
}

export const wildfireRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get<{
    Querystring: { dayRange?: string; source?: string };
  }>("/wildfires", {
    schema: {
      querystring: {
        type: "object",
        properties: {
          dayRange: { type: "string" },
          source: { type: "string" },
        },
      },
    },
    handler: async (req, reply) => {
      const dayRange = Number.parseInt(req.query.dayRange ?? "1", 10);
      const source = req.query.source ?? "VIIRS_SNPP_NRT";

      if (![1, 2, 3].includes(dayRange)) {
        return reply.status(400).send({ message: "Invalid dayRange (1-3)" });
      }
      if (!["VIIRS_SNPP_NRT", "MODIS_NRT"].includes(source)) {
        return reply.status(400).send({ message: "Invalid source" });
      }

      const mapKey = process.env.FIRMS_MAP_KEY;
      if (!mapKey) {
        fastify.log.warn("FIRMS_MAP_KEY not configured");
        return reply.status(503).send({ message: "Wildfire data not configured" });
      }

      const cacheKey = `cache:fire:${source}:${dayRange}`;
      const ttl = TTL.wildfires[dayRange as keyof typeof TTL.wildfires] ?? 300;

      try {
        const { data, status } = await withCacheStatus(
          cacheKey,
          ttl,
          async () => {
            const url = `${FIRMS_BASE}/${mapKey}/${source}/world/${dayRange}`;
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
            const res = await fetch(url, { signal: controller.signal });
            clearTimeout(timer);

            if (!res.ok) {
              fastify.log.warn(`FIRMS API returned ${res.status}`);
              throw new Error("FIRMS API unavailable");
            }

            const csv = await res.text();
            return csvToGeoJSON(csv, source);
          },
          { staleOnError: true },
        );

        reply.header("Cache-Control", `public, max-age=${ttl}`);
        reply.header("X-Cache", status);
        reply.header("X-Refresh-Interval", String(REFRESH_INTERVAL[dayRange] ?? 300_000));
        return data;
      } catch (err) {
        fastify.log.error(err, "Failed to fetch FIRMS data");
        return reply.status(503).send({ message: "Wildfire data temporarily unavailable" });
      }
    },
  });
};

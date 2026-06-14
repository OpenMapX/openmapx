import type { IntegrationContext } from "@openmapx/integration-framework";

const FIRMS_BASE = "https://firms.modaps.eosdis.nasa.gov/api/area/csv";
const FETCH_TIMEOUT_MS = 30_000;

const CACHE_TTL: Record<number, number> = {
  1: 300,
  2: 600,
  3: 900,
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

export function parseAcqDateTime(date: string, time: string): number {
  const h = time.padStart(4, "0").slice(0, 2);
  const m = time.padStart(4, "0").slice(2, 4);
  return new Date(`${date}T${h}:${m}:00Z`).getTime();
}

export function csvToGeoJSON(csv: string, source: string): FireFeatureCollection {
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

export function setup(ctx: IntegrationContext): void {
  ctx.registerRoute("GET", "/wildfires", async (req, reply) => {
    const dayRange = Number.parseInt(req.query.dayRange ?? "1", 10);
    const source = req.query.source ?? "VIIRS_SNPP_NRT";

    if (![1, 2, 3].includes(dayRange)) {
      reply.status(400).send({ message: "Invalid dayRange (1-3)" });
      return;
    }
    if (!["VIIRS_SNPP_NRT", "MODIS_NRT"].includes(source)) {
      reply.status(400).send({ message: "Invalid source" });
      return;
    }

    const mapKey = ctx.config.apiKey as string | undefined;
    if (!mapKey) {
      ctx.log.warn("FIRMS map key not configured");
      reply.status(503).send({ message: "Wildfire data not configured" });
      return;
    }

    const cacheKey = `fire:${source}:${dayRange}`;
    const ttl = CACHE_TTL[dayRange] ?? 300;

    try {
      const cached = await ctx.cache.get<FireFeatureCollection>(cacheKey);
      if (cached) {
        reply.send(cached);
        return;
      }

      const url = `${FIRMS_BASE}/${mapKey}/${source}/world/${dayRange}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);

      if (!res.ok) {
        ctx.log.warn(`FIRMS API returned ${res.status}`);
        reply.status(503).send({ message: "Wildfire data temporarily unavailable" });
        return;
      }

      const csv = await res.text();
      const data = csvToGeoJSON(csv, source);
      await ctx.cache.set(cacheKey, data, ttl);

      reply.send(data);
    } catch (err) {
      ctx.log.error("Failed to fetch FIRMS data", err);

      const stale = await ctx.cache.get<FireFeatureCollection>(cacheKey);
      if (stale) {
        reply.send(stale);
        return;
      }

      reply.status(503).send({ message: "Wildfire data temporarily unavailable" });
    }
  });
}

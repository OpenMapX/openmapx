import { USER_AGENT } from "@openmapx/core";
import type { IntegrationContext } from "@openmapx/integration-framework";

const OPEN_METEO_AQ_BASE = "https://air-quality-api.open-meteo.com/v1/air-quality";
const FETCH_TIMEOUT_MS = 10_000;
const CACHE_TTL = 900; // 15 minutes

interface OpenMeteoAirQualityCurrent {
  time: string;
  pm10: number | null;
  pm2_5: number | null;
  carbon_monoxide: number | null;
  nitrogen_dioxide: number | null;
  sulphur_dioxide: number | null;
  ozone: number | null;
  european_aqi: number | null;
  us_aqi: number | null;
}

interface OpenMeteoAirQualityResponse {
  latitude: number;
  longitude: number;
  current: OpenMeteoAirQualityCurrent;
}

interface AirQualityResult {
  pm25: number | null;
  pm10: number | null;
  no2: number | null;
  o3: number | null;
  so2: number | null;
  co: number | null;
  europeanAqi: number | null;
  usAqi: number | null;
  time: string;
}

function roundCoord(n: number): number {
  return Math.round(n * 100) / 100;
}

export function setup(ctx: IntegrationContext): void {
  ctx.registerRoute("GET", "/aqi", async (req, reply) => {
    const lat = Number.parseFloat(req.query.lat);
    const lng = Number.parseFloat(req.query.lng);

    if (Number.isNaN(lat) || Number.isNaN(lng)) {
      reply.status(400).send({ message: "lat and lng query parameters are required" });
      return;
    }

    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      reply.status(400).send({ message: "lat must be -90..90, lng must be -180..180" });
      return;
    }

    const roundedLat = roundCoord(lat);
    const roundedLng = roundCoord(lng);
    const cacheKey = `aqi:${roundedLat},${roundedLng}`;

    const cached = await ctx.cache.get<AirQualityResult>(cacheKey);
    if (cached) {
      reply.send(cached);
      return;
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      const url = `${OPEN_METEO_AQ_BASE}?latitude=${roundedLat}&longitude=${roundedLng}&current=pm10,pm2_5,carbon_monoxide,nitrogen_dioxide,sulphur_dioxide,ozone,european_aqi,us_aqi`;

      const res = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
        },
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        ctx.log.warn(`Open-Meteo AQ API returned ${res.status}`);
        reply.status(502).send({ message: "Upstream air quality API error" });
        return;
      }

      const data = (await res.json()) as OpenMeteoAirQualityResponse;

      const result: AirQualityResult = {
        pm25: data.current.pm2_5,
        pm10: data.current.pm10,
        no2: data.current.nitrogen_dioxide,
        o3: data.current.ozone,
        so2: data.current.sulphur_dioxide,
        co: data.current.carbon_monoxide,
        europeanAqi: data.current.european_aqi,
        usAqi: data.current.us_aqi,
        time: data.current.time,
      };

      await ctx.cache.set(cacheKey, result, CACHE_TTL);
      reply.send(result);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        ctx.log.warn("Open-Meteo AQ API request timed out");
        reply.status(504).send({ message: "Upstream air quality API timeout" });
        return;
      }
      ctx.log.error(`Open-Meteo AQ API fetch failed: ${err}`);
      reply.status(502).send({ message: "Failed to fetch air quality data" });
    }
  });
}

import type { LngLat, WeatherOptions } from "@openmapx/core";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { createWeatherOrchestrator } from "./orchestrator.js";

function roundCoord2(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

export function setup(ctx: IntegrationContext): void {
  const orchestrator = createWeatherOrchestrator(ctx);

  ctx.registerRoute("GET", "/current", async (req, reply) => {
    const lat = Number.parseFloat(req.query.lat);
    const lng = Number.parseFloat(req.query.lng);

    if (Number.isNaN(lat) || Number.isNaN(lng)) {
      reply.status(400).send({ message: "Invalid coordinates" });
      return;
    }

    const coords: LngLat = [lng, lat];
    const options: WeatherOptions = {
      lang: req.query.lang,
      units: (req.query.units as "metric" | "imperial") ?? "metric",
    };

    const key = `weather:current:${roundCoord2(lat)},${roundCoord2(lng)}:${options.units}`;

    try {
      const result = await ctx.cache.withCache(key, 300, async () => {
        const data = await orchestrator.getCurrentWeather(coords, options);
        if (!data) throw new Error("No weather data available");
        return data;
      });
      reply.header("Cache-Control", "public, max-age=300");
      reply.send(result);
    } catch {
      reply.status(502).send({ message: "Weather data unavailable" });
    }
  });

  ctx.registerRoute("GET", "/forecast", async (req, reply) => {
    const lat = Number.parseFloat(req.query.lat);
    const lng = Number.parseFloat(req.query.lng);

    if (Number.isNaN(lat) || Number.isNaN(lng)) {
      reply.status(400).send({ message: "Invalid coordinates" });
      return;
    }

    const coords: LngLat = [lng, lat];
    const hours = Math.min(Number.parseInt(req.query.hours ?? "48", 10), 168);
    const days = Math.min(Number.parseInt(req.query.days ?? "3", 10), 16);
    const options: WeatherOptions = {
      lang: req.query.lang,
      units: (req.query.units as "metric" | "imperial") ?? "metric",
    };

    const key = `weather:forecast:${roundCoord2(lat)},${roundCoord2(lng)}:${hours}:${days}:${options.units}`;

    try {
      const result = await ctx.cache.withCache(key, 600, async () => {
        const [hourly, daily] = await Promise.all([
          orchestrator.getHourlyForecast(coords, hours, options),
          orchestrator.getDailyForecast(coords, days, options),
        ]);
        return { hourly, daily };
      });
      reply.header("Cache-Control", "public, max-age=600");
      reply.send(result);
    } catch {
      reply.status(502).send({ message: "Forecast data unavailable" });
    }
  });
}

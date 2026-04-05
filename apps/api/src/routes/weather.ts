import type { LngLat, WeatherOptions } from "@openmapx/core";
import type { FastifyPluginAsync } from "fastify";
import {
  getCurrentWeather,
  getDailyForecast,
  getHourlyForecast,
} from "../services/weather.factory.js";
import { TTL, withCache } from "../utils/cache.js";

function roundCoord2(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

export const weatherRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get<{
    Querystring: { lat: string; lng: string; lang?: string; units?: string };
  }>("/weather/current", {
    schema: {
      querystring: {
        type: "object",
        required: ["lat", "lng"],
        properties: {
          lat: { type: "string" },
          lng: { type: "string" },
          lang: { type: "string" },
          units: { type: "string", enum: ["metric", "imperial"] },
        },
      },
    },
    handler: async (req, reply) => {
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
        const result = await withCache(key, TTL.weather.current, async () => {
          const data = await getCurrentWeather(coords, options);
          if (!data) throw new Error("No weather data available");
          return data;
        });
        reply.header("Cache-Control", "public, max-age=300");
        return result;
      } catch {
        reply.status(502).send({ message: "Weather data unavailable" });
      }
    },
  });

  fastify.get<{
    Querystring: {
      lat: string;
      lng: string;
      hours?: string;
      days?: string;
      lang?: string;
      units?: string;
    };
  }>("/weather/forecast", {
    schema: {
      querystring: {
        type: "object",
        required: ["lat", "lng"],
        properties: {
          lat: { type: "string" },
          lng: { type: "string" },
          hours: { type: "string" },
          days: { type: "string" },
          lang: { type: "string" },
          units: { type: "string", enum: ["metric", "imperial"] },
        },
      },
    },
    handler: async (req, reply) => {
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
        const result = await withCache(key, TTL.weather.forecast, async () => {
          const [hourly, daily] = await Promise.all([
            getHourlyForecast(coords, hours, options),
            getDailyForecast(coords, days, options),
          ]);
          return { hourly, daily };
        });
        reply.header("Cache-Control", "public, max-age=600");
        return result;
      } catch {
        reply.status(502).send({ message: "Forecast data unavailable" });
      }
    },
  });
};

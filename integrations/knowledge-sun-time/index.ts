import { fetchJson } from "@openmapx/core";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { find as findTimezone } from "geo-tz";

const API_BASE = "https://api.sunrise-sunset.org/json";
const FETCH_TIMEOUT_MS = 10_000;
const CACHE_TTL = 21_600; // 6 hours — sun times change slowly

// Zone boundaries change on the order of once a year; offsets are the client's
// job via Intl, so nothing in this response can go stale within the window.
const TZ_CACHE_TTL = 2_592_000; // 30 days

interface SunriseSunsetApiResponse {
  results: {
    sunrise: string;
    sunset: string;
    solar_noon: string;
    day_length: number;
    civil_twilight_begin: string;
    civil_twilight_end: string;
    nautical_twilight_begin: string;
    nautical_twilight_end: string;
    astronomical_twilight_begin: string;
    astronomical_twilight_end: string;
  };
  status: string;
  tzid: string;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export function setup(ctx: IntegrationContext): void {
  ctx.registerRoute("GET", "/times", async (req, reply) => {
    const { lat, lng, date } = req.query as { lat?: string; lng?: string; date?: string };

    const latNum = Number.parseFloat(lat ?? "");
    const lngNum = Number.parseFloat(lng ?? "");

    if (Number.isNaN(latNum) || Number.isNaN(lngNum)) {
      reply.status(400).send({ message: "Invalid coordinates" });
      return;
    }

    const dateParam = date ?? "today";
    const tzid = findTimezone(latNum, lngNum)[0] ?? "UTC";
    const cacheKey = `sun-times:${round4(latNum)},${round4(lngNum)}:${dateParam}`;

    const cached = await ctx.cache.get<unknown>(cacheKey);
    if (cached) {
      reply.header("Cache-Control", "public, max-age=3600");
      reply.send(cached);
      return;
    }

    const url =
      `${API_BASE}?lat=${round4(latNum)}&lng=${round4(lngNum)}` +
      `&date=${encodeURIComponent(dateParam)}&formatted=0&tzid=${encodeURIComponent(tzid)}`;

    try {
      const body = await fetchJson<SunriseSunsetApiResponse>(url, {
        timeoutMs: FETCH_TIMEOUT_MS,
        nullOnError: true,
      });

      if (!body) {
        ctx.log.warn("Sunrise-Sunset API request failed");
        reply.status(502).send({ message: "Sunrise-Sunset data unavailable" });
        return;
      }

      if (body.status !== "OK") {
        ctx.log.warn(`Sunrise-Sunset API status: ${body.status}`);
        reply.status(502).send({ message: `Sunrise-Sunset API error: ${body.status}` });
        return;
      }

      const r = body.results;
      const result = {
        sunrise: r.sunrise,
        sunset: r.sunset,
        solarNoon: r.solar_noon,
        dayLength: r.day_length,
        civilTwilightBegin: r.civil_twilight_begin,
        civilTwilightEnd: r.civil_twilight_end,
        nauticalTwilightBegin: r.nautical_twilight_begin,
        nauticalTwilightEnd: r.nautical_twilight_end,
        astronomicalTwilightBegin: r.astronomical_twilight_begin,
        astronomicalTwilightEnd: r.astronomical_twilight_end,
        timezone: tzid,
        attribution: {
          name: "Sunrise-Sunset.org",
          url: "https://sunrise-sunset.org/",
        },
      };

      await ctx.cache.set(cacheKey, result, CACHE_TTL);
      reply.header("Cache-Control", "public, max-age=3600");
      reply.send(result);
    } catch (err) {
      ctx.log.error("Sunrise-Sunset fetch failed", err);
      reply.status(502).send({ message: "Sunrise-Sunset data unavailable" });
    }
  });

  ctx.registerRoute("GET", "/timezone", async (req, reply) => {
    const { lat, lng } = req.query as { lat?: string; lng?: string };

    const latNum = Number.parseFloat(lat ?? "");
    const lngNum = Number.parseFloat(lng ?? "");

    // geo-tz's `find` throws on out-of-range input rather than returning an
    // empty array, so range has to be rejected here — otherwise a value like
    // lat=200 would crash the handler instead of 400ing.
    if (
      Number.isNaN(latNum) ||
      Number.isNaN(lngNum) ||
      latNum < -90 ||
      latNum > 90 ||
      lngNum < -180 ||
      lngNum > 180
    ) {
      reply.status(400).send({ message: "Invalid coordinates" });
      return;
    }

    const cacheKey = `tz:${round4(latNum)},${round4(lngNum)}`;
    const cached = await ctx.cache.get<{ timezone: string }>(cacheKey);
    if (cached) {
      reply.header("Cache-Control", "public, max-age=86400");
      reply.send(cached);
      return;
    }

    // Every in-range coordinate resolves to at least one zone: geo-tz falls
    // back to a 15-degree Etc/GMT band wherever no land polygon covers the
    // point, so the array is never empty here — "UTC" is a defensive
    // fallback only, matching the /times route's use of the same pattern.
    const result = { timezone: findTimezone(latNum, lngNum)[0] ?? "UTC" };
    await ctx.cache.set(cacheKey, result, TZ_CACHE_TTL);
    reply.header("Cache-Control", "public, max-age=86400");
    reply.send(result);
  });
}

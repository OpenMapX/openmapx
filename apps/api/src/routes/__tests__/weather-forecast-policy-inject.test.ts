import type { DailyForecastPoint, HourlyForecastPoint } from "@openmapx/core";
import type {
  LoadedIntegration,
  RouteQuery,
  WeatherProvider,
} from "@openmapx/integration-framework";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { licensingFromDeclaration } from "@openmapx/mobility-core/licensing";
import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { setup } from "../../../../../integrations/weather/index.js";
import { filterGatedSources } from "../../services/data-use-policy.js";

// Exercise the real pure response filter without booting auth/DB integrations.
vi.mock("../../integration-host", () => ({ getAllIntegrations: () => [] }));
vi.mock("../../db", () => ({ db: {} }));

const hourly: HourlyForecastPoint = {
  time: "2026-10-15T12:00:00Z",
  temperature: 12,
  weatherCode: 1,
  precipitationProbability: 0,
  precipitation: 0,
  windSpeed: 5,
  windDirection: 90,
  cloudCover: 10,
  pressure: 1015,
};
const daily: DailyForecastPoint = {
  date: "2026-10-15",
  weatherCode: 1,
  temperatureMax: 14,
  temperatureMin: 8,
  precipitationSum: 0,
  windSpeedMax: 10,
};

function integration(id: string, priority: number): LoadedIntegration {
  const provider: WeatherProvider = {
    id,
    priority,
    getCurrentWeather: async () => {
      throw new Error("not used");
    },
    getHourlyForecast: async () => ({ source: id, points: [hourly] }),
    getDailyForecast: async () => ({ source: id, points: [daily] }),
  };
  return {
    id: `${id}-integration`,
    manifest: {
      id: `${id}-integration`,
      domains: ["weather"],
      dataSources: [
        {
          sourceId: id,
          name: id,
          url: `https://${id}.example/`,
          licensing: licensingFromDeclaration("CC-BY-4.0"),
        },
      ],
    },
    providers: new Map([["weather", [provider]]]),
  } as LoadedIntegration;
}

it("reacquires an allowed forecast fallback after cached supplier policy changes, through HTTP serialization", async () => {
  let gated = new Set<string>();
  const ctx = createMockIntegrationContext({ id: "weather" });
  ctx.getDisallowedSourceIds = async () => gated;
  ctx.getIntegrationsByDomain = () => [integration("preferred", 1), integration("fallback", 2)];
  const values = new Map<string, string>();
  ctx.cache.withCache = async <T>(
    key: string,
    _ttl: number,
    load: (signal: AbortSignal) => Promise<T>,
  ) => {
    const cached = values.get(key);
    if (cached !== undefined) return JSON.parse(cached) as T;
    const result = await load(new AbortController().signal);
    values.set(key, JSON.stringify(result));
    return result;
  };
  setup(ctx);
  const route = ctx.registered.routes.find((r) => r.path === "/forecast");
  if (!route) throw new Error("missing forecast route");
  const app = Fastify();
  app.addHook("preSerialization", (_request, _reply, payload, done) => {
    done(null, filterGatedSources(payload, gated));
  });
  app.get("/forecast", async (request, reply) => {
    await route.handler(
      { query: request.query as RouteQuery, params: {}, body: null, headers: request.headers },
      reply,
    );
  });
  try {
    const read = async () => {
      const response = await app.inject("/forecast?lat=52&lng=13");
      expect(response.statusCode).toBe(200);
      return response.json();
    };
    const allowed = await read();
    expect(allowed.hourly.source).toBe("preferred");
    expect(allowed.daily.source).toBe("preferred");
    gated = new Set(["preferred"]);
    const restricted = await read();
    expect(restricted.hourly.source).toBe("fallback");
    expect(restricted.daily.source).toBe("fallback");
    expect(restricted.hourly.points[0].contributors[0].sourceId).toBe("fallback");
    gated = new Set(["preferred", "fallback"]);
    expect(await read()).toEqual({
      hourly: { source: null, points: [], contributors: [] },
      daily: { source: null, points: [], contributors: [] },
    });
    gated = new Set();
    expect(await read()).toEqual(allowed);
  } finally {
    await app.close();
  }
});

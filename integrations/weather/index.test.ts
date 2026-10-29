import type {
  DailyForecastPoint,
  HourlyForecastPoint,
  WeatherForecastResponse,
} from "@openmapx/core";
import type {
  IntegrationDataSource,
  LoadedIntegration,
  WeatherProvider,
} from "@openmapx/integration-framework";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { licensingFromDeclaration } from "@openmapx/mobility-core/licensing";
import { describe, expect, it } from "vitest";
import { setup } from "./index.js";
import { createWeatherOrchestrator } from "./orchestrator.js";

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

function source(sourceId: string, name = sourceId): IntegrationDataSource {
  return {
    sourceId,
    name,
    url: `https://${sourceId}.example/`,
    licensing: licensingFromDeclaration("CC-BY-4.0"),
    providerCountry: "DE",
    providerPrivacyUrl: `https://${sourceId}.example/privacy`,
  };
}

function integration(
  provider: WeatherProvider,
  dataSources = [source(provider.id)],
): LoadedIntegration {
  return {
    id: `${provider.id}-integration`,
    manifest: { id: `${provider.id}-integration`, domains: ["weather"], dataSources },
    providers: new Map([["weather", [provider]]]),
  } as LoadedIntegration;
}

function context(integrations: LoadedIntegration[]) {
  const ctx = createMockIntegrationContext({ id: "weather" });
  ctx.getIntegrationsByDomain = () => integrations;
  return ctx;
}

function provider(
  id: string,
  forecast: () => Promise<WeatherForecastResponse<HourlyForecastPoint | DailyForecastPoint>>,
): WeatherProvider {
  return {
    id,
    priority: 10,
    getCurrentWeather: async () => {
      throw new Error("not used");
    },
    getHourlyForecast: forecast as WeatherProvider["getHourlyForecast"],
    getDailyForecast: forecast as WeatherProvider["getDailyForecast"],
  };
}

describe.each([
  ["hourly", "getHourlyForecast", hourly],
  ["daily", "getDailyForecast", daily],
] as const)("%s forecast contributor capture", (_name, method, point) => {
  it("captures only the selected fallback's exact source before its await", async () => {
    const selectedSource = source("selected-feed", "Before first attempt");
    const failing = provider("failed", async () => {
      selectedSource.name = "Before selected acquisition";
      throw new Error("try next");
    });
    const selected = provider("adapter", async () => {
      selectedSource.name = "Changed during selected acquisition";
      return { source: "selected-feed", points: [point] };
    });
    const ctx = context([
      integration(failing),
      integration(selected, [selectedSource, source("unused-feed")]),
    ]);
    const result = await createWeatherOrchestrator(ctx)[method]([13, 52], 2);
    expect(result.source).toBe("selected-feed");
    expect(result.contributors).toMatchObject([
      { sourceId: "selected-feed", name: "Before selected acquisition" },
    ]);
    expect(result.points[0]?.contributors).toEqual(result.contributors);
    selectedSource.name = "Changed after acquisition";
    expect(JSON.parse(JSON.stringify(result)).points[0].contributors[0].name).toBe(
      "Before selected acquisition",
    );
  });

  it("preserves authoritative empty and native point receipts", async () => {
    const native = { sourceId: "native", name: "Captured native terms" };
    const ctx = context([
      integration(
        provider("adapter", async () => ({
          source: "adapter",
          contributors: [],
          points: [point, { ...point, contributors: [] }, { ...point, contributors: [native] }],
        })),
      ),
    ]);
    const result = await createWeatherOrchestrator(ctx)[method]([13, 52], 3);
    native.name = "Changed after acquisition";
    expect(result.points.map((p) => p.contributors)).toEqual([
      [],
      [],
      [{ sourceId: "native", name: "Captured native terms" }],
    ]);
    expect(result.contributors).toEqual([{ sourceId: "native", name: "Captured native terms" }]);
  });

  it("retains supplied envelope notices and lets an empty point block inheritance", async () => {
    const receipt = { sourceId: "adapter", name: "Producer-captured notice" };
    const ctx = context([
      integration(
        provider("adapter", async () => ({
          source: "adapter",
          contributors: [receipt],
          points: [point, { ...point, contributors: [] }],
        })),
      ),
    ]);
    const result = await createWeatherOrchestrator(ctx)[method]([13, 52], 2);
    receipt.name = "Changed producer notice";
    expect(result.points.map((p) => p.contributors)).toEqual([
      [{ sourceId: "adapter", name: "Producer-captured notice" }],
      [],
    ]);
    expect(result.contributors).toEqual([
      { sourceId: "adapter", name: "Producer-captured notice" },
    ]);
  });

  it("captures a runtime feed catalogue before the provider identifies its selected feed", async () => {
    let name = "Runtime feed at acquisition";
    const ctx = context([
      integration(
        provider("adapter", async () => {
          name = "Changed runtime feed";
          return { source: "runtime-feed", points: [point] };
        }),
      ),
    ]);
    Object.defineProperty(ctx, "attributionIndex", {
      value: { list: () => [{ sourceId: "runtime-feed", name }] },
    });
    const result = await createWeatherOrchestrator(ctx)[method]([13, 52], 1);
    expect(result.points[0]?.contributors).toEqual([
      { sourceId: "runtime-feed", name: "Runtime feed at acquisition" },
    ]);
  });

  it("does not infer an unknown or mixed supplier from the provider catalogue", async () => {
    for (const contributors of [
      undefined,
      [
        { sourceId: "first", name: "First" },
        { sourceId: "second", name: "Second" },
      ],
    ]) {
      const ctx = context([
        integration(
          provider("adapter", async () => ({ source: "unknown", contributors, points: [point] })),
        ),
      ]);
      const result = await createWeatherOrchestrator(ctx)[method]([13, 52], 1);
      expect(result.points[0]?.contributors).toEqual([]);
      expect(result.contributors).toEqual([]);
    }
  });

  it("skips policy-excluded providers and returns explicit unavailable receipts", async () => {
    const ctx = context([
      integration(provider("excluded", async () => ({ source: "excluded", points: [point] }))),
    ]);
    ctx.getDisallowedSourceIds = async () => new Set(["excluded"]);
    expect(await createWeatherOrchestrator(ctx)[method]([13, 52], 1)).toEqual({
      source: null,
      points: [],
      contributors: [],
    });
  });

  it("rejects an adapter's selected source when policy excludes that source", async () => {
    const ctx = context([
      integration(
        provider("adapter", async () => ({ source: "gated-feed", points: [point] })),
        [source("gated-feed")],
      ),
      integration(provider("fallback", async () => ({ source: "fallback", points: [point] }))),
    ]);
    ctx.getDisallowedSourceIds = async () => new Set(["gated-feed"]);
    const result = await createWeatherOrchestrator(ctx)[method]([13, 52], 1);
    expect(result.source).toBe("fallback");
    expect(result.contributors).toMatchObject([{ sourceId: "fallback" }]);
  });

  it("keeps a successful empty forecast empty without borrowing fallback credits", async () => {
    const ctx = context([
      integration(provider("empty", async () => ({ source: "empty", points: [] }))),
      integration(provider("unused", async () => ({ source: "unused", points: [point] }))),
    ]);
    expect(await createWeatherOrchestrator(ctx)[method]([13, 52], 1)).toEqual({
      source: "empty",
      points: [],
      contributors: [],
    });
  });
});

it("serializes independent hourly/daily suppliers and keeps receipts on forecast cache hits", async () => {
  const first = provider("hourly", async () => ({ source: "hourly", points: [hourly] }));
  first.getDailyForecast = async () => {
    throw new Error("daily unavailable here");
  };
  const second = provider("daily", async () => ({ source: "daily", points: [daily] }));
  const hourlySource = source("hourly", "Acquired hourly terms");
  const dailySource = source("daily", "Acquired daily terms");
  const ctx = context([integration(first, [hourlySource]), integration(second, [dailySource])]);
  // JSON storage exercises the actual portable envelope/point shape, including [].
  const values = new Map([
    ["weather:forecast:52.00,13.00:48:3:metric", JSON.stringify({ hourly: [], daily: [] })],
  ]);
  ctx.cache.withCache = async <T>(
    key: string,
    _ttl: number,
    load: (signal: AbortSignal) => Promise<T>,
  ) => {
    const previous = values.get(key);
    if (previous !== undefined) return JSON.parse(previous) as T;
    const value = await load(new AbortController().signal);
    values.set(key, JSON.stringify(value));
    return value;
  };
  setup(ctx);
  const route = ctx.registered.routes.find((r) => r.path === "/forecast");
  if (!route) throw new Error("missing forecast route");
  const read = async () => {
    let body: unknown;
    const reply = {
      header: () => {},
      type: () => {},
      status: () => reply,
      send: (value: unknown) => {
        body = JSON.parse(JSON.stringify(value));
      },
    };
    await route.handler(
      { query: { lat: "52", lng: "13" }, params: {}, body: null, headers: {} },
      reply,
    );
    return body as {
      hourly: WeatherForecastResponse<HourlyForecastPoint>;
      daily: WeatherForecastResponse<DailyForecastPoint>;
    };
  };
  const firstResponse = await read();
  expect(firstResponse.hourly.points[0]?.contributors).toMatchObject([
    { sourceId: "hourly", name: "Acquired hourly terms" },
  ]);
  expect(firstResponse.daily.points[0]?.contributors).toMatchObject([
    { sourceId: "daily", name: "Acquired daily terms" },
  ]);
  hourlySource.name = "New hourly terms";
  dailySource.name = "New daily terms";
  expect(await read()).toEqual(firstResponse);
});

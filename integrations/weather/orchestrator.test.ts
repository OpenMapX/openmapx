import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  effectiveProviderOrder,
  type LoadedIntegration,
  type WeatherProvider,
} from "@openmapx/integration-framework";
import {
  createMockIntegrationContext,
  routeRequest,
} from "@openmapx/integration-framework/testing";
import { describe, expect, it, vi } from "vitest";
import { setup } from "./index.js";
import { createWeatherOrchestrator } from "./orchestrator.js";

function weatherProvider(
  id: string,
  priority: number,
  extra: Partial<WeatherProvider> = {},
): WeatherProvider {
  return {
    id,
    priority,
    getCurrentWeather: vi.fn(async () => ({
      source: id,
      current: { temperature: 20 },
      location: [13, 52],
    })) as unknown as WeatherProvider["getCurrentWeather"],
    ...extra,
  };
}

function integration(id: string, provider: WeatherProvider): LoadedIntegration {
  return {
    id,
    config: {},
    manifest: { id, domains: ["weather"], dataSources: [] },
    providers: new Map([["weather", [provider]]]),
  } as unknown as LoadedIntegration;
}

function hostLike(integrations: LoadedIntegration[], order: readonly string[] = []) {
  const ctx = createMockIntegrationContext({ id: "weather", providerOrder: { weather: order } });
  ctx.getIntegrationsByDomain = (domain) => (domain === "weather" ? integrations : []);
  return ctx;
}

function providerOf(entry: LoadedIntegration): WeatherProvider {
  const [provider] = entry.providers.get("weather") as WeatherProvider[];
  if (!provider) throw new Error(`${entry.id} has no weather provider`);
  return provider;
}

/** The integrations whose provider was asked, in the order they were asked. */
async function askedFor(integrations: LoadedIntegration[], ctx = hostLike(integrations)) {
  const asked: string[] = [];
  for (const entry of integrations) {
    providerOf(entry).getCurrentWeather = async () => {
      asked.push(entry.id);
      throw new Error("try the next source");
    };
  }
  await createWeatherOrchestrator(ctx).getCurrentWeather([13, 52]);
  return asked;
}

describe("weather sources in the operator's order", () => {
  it("asks an installed source at the position the operator chose", async () => {
    const acme = integration("weather-acme", weatherProvider("acme", 50));
    const openMeteo = integration("weather-open-meteo", weatherProvider("open-meteo", 10));
    const ctx = hostLike([openMeteo, acme], ["weather-acme", "weather-open-meteo"]);
    const result = await createWeatherOrchestrator(ctx).getCurrentWeather([13, 52]);
    expect(result?.source).toBe("acme");
    expect(providerOf(openMeteo).getCurrentWeather).not.toHaveBeenCalled();
  });

  it("appends an unlisted source after the listed ones", async () => {
    const acme = integration("weather-acme", weatherProvider("acme", 1));
    const openMeteo = integration("weather-open-meteo", weatherProvider("open-meteo", 10));
    const ctx = hostLike([acme, openMeteo], ["weather-open-meteo"]);
    expect(await askedFor([acme, openMeteo], ctx)).toEqual(["weather-open-meteo", "weather-acme"]);
  });

  it("does not serve a cached answer after the provider set changed", async () => {
    const integrations = [integration("weather-open-meteo", weatherProvider("open-meteo", 10))];
    const ctx = hostLike(integrations);
    const keys: string[] = [];
    ctx.cache.withCache = async <T>(
      key: string,
      _ttl: number,
      load: (signal: AbortSignal) => Promise<T>,
    ) => {
      keys.push(key);
      return load(new AbortController().signal);
    };
    setup(ctx);
    const current = ctx.registered.routes.find((route) => route.path === "/current");
    const forecast = ctx.registered.routes.find((route) => route.path === "/forecast");
    if (!current || !forecast) throw new Error("missing weather routes");
    const reply = {
      header: () => reply,
      status: () => reply,
      send: () => reply,
      type: () => reply,
    };
    const read = async () => {
      for (const route of [current, forecast])
        await route.handler(routeRequest({ query: { lat: "52", lng: "13" }, body: null }), reply);
    };
    await read();
    await read();
    integrations.push(integration("weather-acme", weatherProvider("acme", 1)));
    await read();
    expect(keys[2]).toBe(keys[0]);
    expect(keys[3]).toBe(keys[1]);
    expect(keys[4]).not.toBe(keys[0]);
    expect(keys[5]).not.toBe(keys[1]);
  });

  it("skips a provider whose integration the data-use policy disallows", async () => {
    const acme = integration("weather-acme", weatherProvider("acme-feed", 1));
    const openMeteo = integration("weather-open-meteo", weatherProvider("open-meteo", 10));
    const ctx = hostLike([acme, openMeteo]);
    ctx.getDisallowedSourceIds = async () => new Set(["acme-dwd", "acme-ecmwf"]);
    ctx.getDisallowedIntegrationIds = async () => new Set(["weather-acme"]);
    const result = await createWeatherOrchestrator(ctx).getCurrentWeather([13, 52]);
    expect(result?.source).toBe("open-meteo");
    expect(providerOf(acme).getCurrentWeather).not.toHaveBeenCalled();
  });

  it("skips a provider all of whose declared sources are disallowed", async () => {
    const acme = integration("weather-acme", weatherProvider("acme", 1, { sourceIds: ["a", "b"] }));
    const openMeteo = integration("weather-open-meteo", weatherProvider("open-meteo", 10));
    const ctx = hostLike([acme, openMeteo]);
    ctx.getDisallowedSourceIds = async () => new Set(["a", "b"]);
    const result = await createWeatherOrchestrator(ctx).getCurrentWeather([13, 52]);
    expect(result?.source).toBe("open-meteo");
    expect(providerOf(acme).getCurrentWeather).not.toHaveBeenCalled();

    ctx.getDisallowedSourceIds = async () => new Set(["a"]);
    expect((await createWeatherOrchestrator(ctx).getCurrentWeather([13, 52]))?.source).toBe("acme");
  });

  it.each([
    ["a string", "acme"],
    ["an array-like object", { length: 1, 0: "elsewhere" }],
    ["an array without string entries", [3, null]],
  ])("treats a malformed sourceIds (%s) as absent", async (_name, sourceIds) => {
    const acme = integration(
      "weather-acme",
      weatherProvider("acme", 1, { sourceIds: sourceIds as unknown as readonly string[] }),
    );
    const openMeteo = integration("weather-open-meteo", weatherProvider("open-meteo", 10));
    const ctx = hostLike([acme, openMeteo]);
    ctx.getDisallowedSourceIds = async () => new Set(["acme"]);
    const result = await createWeatherOrchestrator(ctx).getCurrentWeather([13, 52]);
    expect(result?.source).toBe("open-meteo");
    expect(providerOf(acme).getCurrentWeather).not.toHaveBeenCalled();
  });

  it("keeps only the string entries of sourceIds", async () => {
    const acme = integration(
      "weather-acme",
      weatherProvider("acme", 1, { sourceIds: ["a", 7] as unknown as readonly string[] }),
    );
    const openMeteo = integration("weather-open-meteo", weatherProvider("open-meteo", 10));
    const ctx = hostLike([acme, openMeteo]);
    ctx.getDisallowedSourceIds = async () => new Set(["a"]);
    expect((await createWeatherOrchestrator(ctx).getCurrentWeather([13, 52]))?.source).toBe(
      "open-meteo",
    );
  });

  it("treats an empty sourceIds as absent, so the provider id is its source", async () => {
    const acme = integration("weather-acme", weatherProvider("acme", 1, { sourceIds: [] }));
    const openMeteo = integration("weather-open-meteo", weatherProvider("open-meteo", 10));
    const ctx = hostLike([acme, openMeteo]);
    ctx.getDisallowedSourceIds = async () => new Set(["acme"]);
    expect((await createWeatherOrchestrator(ctx).getCurrentWeather([13, 52]))?.source).toBe(
      "open-meteo",
    );
    expect(providerOf(acme).getCurrentWeather).not.toHaveBeenCalled();

    ctx.getDisallowedSourceIds = async () => new Set(["unrelated"]);
    expect((await createWeatherOrchestrator(ctx).getCurrentWeather([13, 52]))?.source).toBe("acme");
  });

  it("skips current weather whose answering source the policy disallows", async () => {
    const adapter = integration(
      "weather-adapter",
      weatherProvider("adapter", 1, {
        getCurrentWeather: vi.fn(async () => ({
          source: "gated-feed",
          current: { temperature: 1 },
          location: [13, 52],
        })) as unknown as WeatherProvider["getCurrentWeather"],
      }),
    );
    const openMeteo = integration("weather-open-meteo", weatherProvider("open-meteo", 10));
    const ctx = hostLike([adapter, openMeteo]);
    ctx.getDisallowedSourceIds = async () => new Set(["gated-feed"]);
    const result = await createWeatherOrchestrator(ctx).getCurrentWeather([13, 52]);
    expect(result?.source).toBe("open-meteo");
    expect(providerOf(adapter).getCurrentWeather).toHaveBeenCalledOnce();
  });

  it("does not replay a cached current answer after the data-use policy changed", async () => {
    const ctx = hostLike([integration("weather-open-meteo", weatherProvider("open-meteo", 10))]);
    const keys: string[] = [];
    ctx.cache.withCache = async <T>(
      key: string,
      _ttl: number,
      load: (signal: AbortSignal) => Promise<T>,
    ) => {
      keys.push(key);
      return load(new AbortController().signal);
    };
    setup(ctx);
    const current = ctx.registered.routes.find((route) => route.path === "/current");
    if (!current) throw new Error("missing the current weather route");
    const reply = {
      header: () => reply,
      status: () => reply,
      send: () => reply,
      type: () => reply,
    };
    const read = () =>
      current.handler(routeRequest({ query: { lat: "52", lng: "13" }, body: null }), reply);
    await read();
    await read();
    ctx.getDisallowedSourceIds = async () => new Set(["open-meteo"]);
    await read();
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
  });
});

describe("served weather order, fingerprint and admin list", () => {
  const builtIns = () => [
    integration("weather-open-meteo", weatherProvider("open-meteo", 10)),
    integration("weather-met-norway", weatherProvider("met-norway", 8)),
    integration("weather-bright-sky", weatherProvider("bright-sky", 3)),
    integration("weather-openweathermap", weatherProvider("openweathermap", 5)),
  ];

  it("agree on the served sequence", async () => {
    const integrations = [...builtIns(), integration("weather-acme", weatherProvider("acme", 1))];
    const order = ["weather-met-norway", "ghost", "weather-open-meteo"];
    const ctx = hostLike(integrations, order);
    const asked = await askedFor(integrations, ctx);
    expect(asked).toEqual([
      "weather-met-norway",
      "weather-open-meteo",
      "weather-acme",
      "weather-bright-sky",
      "weather-openweathermap",
    ]);
    expect(
      effectiveProviderOrder(order, integrations, "weather").map((entry) => entry.integrationId),
    ).toEqual(asked);
    const providerIds = new Map(integrations.map((entry) => [entry.id, providerOf(entry).id]));
    expect(ctx.getProviderOrderFingerprint("weather")).toBe(
      createHash("sha256")
        .update(JSON.stringify(asked.map((id) => [id, providerIds.get(id)])))
        .digest("hex")
        .slice(0, 16),
    );
  });

  it("serves the built-in sources in priority order with the default configuration", async () => {
    const manifest = JSON.parse(
      readFileSync(new URL("./manifest.json", import.meta.url), "utf8"),
    ) as { configSchema: { properties: { providerOrder: { default: string[] } } } };
    const defaultOrder = manifest.configSchema.properties.providerOrder.default;
    const integrations = builtIns();
    const byPriority = [...integrations]
      .sort((a, b) => providerOf(a).priority - providerOf(b).priority)
      .map((entry) => entry.id);
    expect(await askedFor(integrations, hostLike(integrations, defaultOrder))).toEqual(byPriority);
    const unordered = builtIns();
    expect(await askedFor(unordered, hostLike(unordered))).toEqual(byPriority);
  });
});

import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { licensingFromDeclaration } from "@openmapx/mobility-core/licensing";
import { expect, it } from "vitest";
import { createWeatherOrchestrator } from "./orchestrator";

it("captures the actual successful weather response before the caller caches it", async () => {
  const result = { location: [6, 51], current: { temperature: 20 }, source: "winner" };
  const ctx = createMockIntegrationContext();
  ctx.getIntegrationsByDomain = () =>
    [
      {
        id: "weather-a",
        name: "Weather A",
        enabled: true,
        manifest: {
          domains: ["weather"],
          dataSources: [
            {
              sourceId: "a",
              name: "Failed A",
              url: "https://a.test",
              licensing: licensingFromDeclaration("CC0", undefined),
            },
          ],
        },
        providers: new Map([
          [
            "weather",
            [
              {
                id: "a",
                priority: 1,
                getCurrentWeather: async () => {
                  throw new Error("failed");
                },
              },
            ],
          ],
        ]),
        dataSources: [
          {
            sourceId: "a",
            name: "Failed A",
            url: "https://a.test",
            licensing: licensingFromDeclaration("CC0", undefined),
          },
        ],
      },
      {
        id: "weather-b",
        name: "Weather B",
        enabled: true,
        manifest: {
          domains: ["weather"],
          dataSources: [
            {
              sourceId: "winner",
              name: "Actual B",
              url: "https://b.test",
              licensing: licensingFromDeclaration("CC0", undefined),
            },
          ],
        },
        providers: new Map([
          ["weather", [{ id: "winner", priority: 2, getCurrentWeather: async () => result }]],
        ]),
        dataSources: [
          {
            sourceId: "winner",
            name: "Actual B",
            url: "https://b.test",
            licensing: licensingFromDeclaration("CC0", undefined),
          },
        ],
      },
    ] as never;
  const data = await createWeatherOrchestrator(ctx).getCurrentWeather([6, 51]);
  expect(data?.contributors?.map((a) => a.sourceId)).toEqual(["winner"]);
  expect(data).not.toBe(result);
  expect(result).not.toHaveProperty("contributors");
});

it.each(["declared", "runtime"] as const)(
  "keeps the %s catalogue from before each weather acquisition",
  async (kind) => {
    const source = {
      sourceId: "winner",
      name: "Captured",
      url: "https://old.test",
      licensing: licensingFromDeclaration("CC0", undefined),
      attribution: "Old required notice",
    };
    const receipt = {
      sourceId: "winner",
      name: "Captured",
      url: "https://old.test",
      licensing: licensingFromDeclaration("CC0", undefined, "Captured"),
      attributionText: "Old required notice",
      publisher: { name: "Original publisher" },
    };
    const started = Promise.withResolvers<void>();
    const response = Promise.withResolvers<void>();
    const ctx = createMockIntegrationContext();
    ctx.getIntegrationsByDomain = () =>
      [
        {
          id: "adapter",
          manifest: { dataSources: kind === "declared" ? [source] : [] },
          providers: new Map([
            [
              "weather",
              [
                {
                  id: "winner",
                  priority: 1,
                  async getCurrentWeather() {
                    started.resolve();
                    await response.promise;
                    return { source: "winner", current: { temperature: 20 }, location: [6, 51] };
                  },
                },
              ],
            ],
          ]),
        },
      ] as never;
    if (kind === "runtime")
      Object.assign(ctx, { attributionIndex: { list: () => [receipt], getById: () => receipt } });
    const pending = createWeatherOrchestrator(ctx).getCurrentWeather([6, 51]);
    await started.promise;
    source.attribution = "New required notice";
    receipt.attributionText = "New required notice";
    receipt.publisher.name = "Changed publisher";
    response.resolve();
    const data = await pending;
    expect(data?.contributors).toMatchObject([
      { sourceId: "winner", attributionText: "Old required notice", url: "https://old.test" },
    ]);
    if (kind === "runtime")
      expect(data?.contributors?.[0].publisher).toEqual({ name: "Original publisher" });
  },
);

it("captures a fallback's metadata when its own acquisition starts and preserves native empty receipts", async () => {
  const source = {
    sourceId: "winner",
    name: "Winner",
    url: "https://winner.test",
    licensing: licensingFromDeclaration("CC0", undefined),
    attribution: "Before first attempt",
  };
  const ctx = createMockIntegrationContext();
  let native = false;
  ctx.getIntegrationsByDomain = () =>
    [
      {
        id: "adapter",
        manifest: { dataSources: [source] },
        providers: new Map([
          [
            "weather",
            [
              {
                id: "failed",
                priority: 1,
                async getCurrentWeather() {
                  source.attribution = "At fallback acquisition";
                  throw new Error("failed");
                },
              },
              {
                id: "winner",
                priority: 2,
                async getCurrentWeather() {
                  source.attribution = "After fallback acquisition";
                  return {
                    source: "winner",
                    current: { temperature: 20 },
                    location: [6, 51],
                    ...(native ? { contributors: [] } : {}),
                  };
                },
              },
            ],
          ],
        ]),
      },
    ] as never;
  const orchestrator = createWeatherOrchestrator(ctx);
  expect((await orchestrator.getCurrentWeather([6, 51]))?.contributors?.[0].attributionText).toBe(
    "At fallback acquisition",
  );
  native = true;
  expect((await orchestrator.getCurrentWeather([6, 51]))?.contributors).toEqual([]);
});

it("isolates old weather caches and keeps the acquired receipt on retained responses", async () => {
  const { setup } = await import("./index");
  const source = {
    sourceId: "winner",
    name: "Captured",
    url: "https://old.test",
    licensing: licensingFromDeclaration("CC0", undefined),
    attribution: "Original notice",
  };
  const entries = new Map<string, unknown>([
    [
      "weather:current:contributors-v1:51.00,6.00:metric",
      { source: "winner", contributors: [{ sourceId: "winner", name: "Incorrect old cache" }] },
    ],
  ]);
  const ctx = createMockIntegrationContext();
  ctx.cache.withCache = async (key, _ttl, acquire) => {
    if (!entries.has(key))
      entries.set(key, JSON.parse(JSON.stringify(await acquire(new AbortController().signal))));
    return entries.get(key) as never;
  };
  ctx.getIntegrationsByDomain = () =>
    [
      {
        id: "adapter",
        manifest: { dataSources: [source] },
        providers: new Map([
          [
            "weather",
            [
              {
                id: "winner",
                priority: 1,
                getCurrentWeather: async () => ({
                  source: "winner",
                  current: { temperature: 20 },
                  location: [6, 51],
                }),
              },
            ],
          ],
        ]),
      },
    ] as never;
  setup(ctx);
  const route = ctx.registered.routes.find((row) => row.path === "/current");
  const sent: unknown[] = [];
  const reply = {
    header() {},
    send(value: unknown) {
      sent.push(value);
    },
  };
  await route?.handler({ query: { lat: "51", lng: "6" } } as never, reply as never);
  source.attribution = "Changed live notice";
  await route?.handler({ query: { lat: "51", lng: "6" } } as never, reply as never);
  expect(sent).toHaveLength(2);
  for (const data of sent)
    expect(data).toMatchObject({
      contributors: [{ sourceId: "winner", attributionText: "Original notice" }],
    });
});

it("credits a provider's data as modified where its service changes the source's data", async () => {
  const source = {
    sourceId: "changed",
    name: "DWD via a service",
    url: "https://service.test",
    licensing: licensingFromDeclaration("CC-BY-4.0", undefined),
  };
  const integration = (changesSourceData: boolean) =>
    [
      {
        id: "weather-service",
        name: "Weather service",
        enabled: true,
        manifest: { domains: ["weather"], dataSources: [source] },
        providers: new Map([
          [
            "weather",
            [
              {
                id: "changed",
                priority: 1,
                ...(changesSourceData ? { changesSourceData } : {}),
                getCurrentWeather: async () => ({
                  location: [6, 51],
                  current: {},
                  source: "changed",
                }),
                getHourlyForecast: async () => ({
                  source: "changed",
                  points: [{ time: "2026-10-31T12:00:00Z", temperature: 10 }],
                }),
              },
            ],
          ],
        ]),
        dataSources: [source],
      },
    ] as never;
  const ctx = createMockIntegrationContext();
  ctx.getIntegrationsByDomain = () => integration(true);
  const weather = createWeatherOrchestrator(ctx);
  const current = await weather.getCurrentWeather([6, 51]);
  expect(current?.contributors?.map((c) => c.modified)).toEqual([true]);
  const hourly = await weather.getHourlyForecast([6, 51], 1);
  expect(hourly.points[0]?.contributors?.map((c) => c.modified)).toEqual([true]);
  ctx.getIntegrationsByDomain = () => integration(false);
  const plain = await createWeatherOrchestrator(ctx).getCurrentWeather([6, 51]);
  expect(plain?.contributors?.map((c) => c.modified)).toEqual([undefined]);
});

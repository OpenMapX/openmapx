import { describe, expect, it } from "vitest";
import { createMockIntegrationContext } from "./index";

describe("createMockIntegrationContext", () => {
  it("resolves a declared required service in the mock context", () => {
    const ctx = createMockIntegrationContext({
      requiredServices: { "demo-engine": "http://demo:8080" },
    });
    expect(ctx.getRequiredService("demo-engine")).toEqual({
      serviceId: "demo-engine",
      url: "http://demo:8080",
      enabled: true,
    });
    expect(ctx.getRequiredService("other")).toBeNull();
  });

  it("resolves no required service when none is declared", () => {
    expect(createMockIntegrationContext().getRequiredService("demo-engine")).toBeNull();
  });

  it("offers ctx.db when the host would", async () => {
    const notStubbed = "createMockIntegrationContext: database not stubbed — pass { db }";
    expect(createMockIntegrationContext().db).toBeUndefined();

    const postgis = createMockIntegrationContext({
      manifest: { requires: [{ service: "postgis" }] } as never,
    }).db;
    expect(postgis).toBeDefined();
    expect(postgis?.schema).toBeUndefined();
    await expect(postgis?.execute("select 1")).rejects.toThrow(notStubbed);
    await expect(postgis?.transaction(async () => 1)).rejects.toThrow(notStubbed);

    expect(
      createMockIntegrationContext({
        id: "demo-data",
        manifest: { database: { migrations: true } } as never,
      }).db?.schema,
    ).toBe("ext_demo_data");

    const db = {
      execute: async <T>() => [] as T,
      transaction: <T>(fn: (tx: { execute: <R>() => Promise<R> }) => Promise<T>) =>
        fn({ execute: async <R>() => [] as R }),
    };
    expect(createMockIntegrationContext({ db }).db).toBe(db);
  });

  it("refuses at registration the providers the host refuses", () => {
    const ctx = createMockIntegrationContext({ id: "demo" });
    const weather = {
      id: "w",
      priority: 1,
      getCurrentWeather: async () => null as never,
    };

    expect(() => ctx.registerWeatherProvider({ id: "w", priority: 1 } as never)).toThrow(
      /getCurrentWeather/,
    );
    ctx.registerWeatherProvider(weather);
    expect(() => ctx.registerWeatherProvider({ ...weather })).toThrow(
      "Integration demo: weather provider w is registered twice",
    );
    expect(ctx.registered.weather).toEqual([weather]);
  });
});

import { describe, expect, it, vi } from "vitest";
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

    const execute = vi.fn(async () => [{ id: 1 }]);
    const db = {
      execute: execute as <T>() => Promise<T>,
      transaction: <T>(fn: (tx: { execute: <R>() => Promise<R> }) => Promise<T>) =>
        fn({ execute: async <R>() => [] as R }),
      schema: "ext_demo",
    };
    const stubbed = createMockIntegrationContext({ db }).db;
    expect(await stubbed?.execute("select 1", [2])).toEqual([{ id: 1 }]);
    expect(execute).toHaveBeenCalledWith("select 1", [2]);
    expect(await stubbed?.transaction(async () => "done")).toBe("done");
    expect(stubbed?.schema).toBe("ext_demo");
  });

  it("refuses a transaction started inside another, as the host does", async () => {
    const db = createMockIntegrationContext({
      db: {
        execute: async <T>() => [] as T,
        transaction: <T>(fn: (tx: { execute: <R>() => Promise<R> }) => Promise<T>) =>
          fn({ execute: async <R>() => [] as R }),
      },
    }).db;
    let openLater!: () => void;
    const laterGate = new Promise<void>((resolve) => {
      openLater = resolve;
    });
    let later: Promise<string> | undefined;

    await db?.transaction(async () => {
      await expect(db.transaction(async () => "inner")).rejects.toThrow(
        "Nested transactions are not supported; use the transaction passed to the callback",
      );
      later = laterGate.then(() => db.transaction(async () => "later"));
    });
    openLater();

    await expect(later).resolves.toBe("later");
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

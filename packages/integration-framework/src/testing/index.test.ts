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

  it("runs one transaction at a time, in the order they were called, as the host does", async () => {
    const events: string[] = [];
    let finishFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const db = createMockIntegrationContext({
      db: {
        execute: async <T>() => [] as T,
        transaction: <T>(fn: (tx: { execute: <R>() => Promise<R> }) => Promise<T>) =>
          fn({ execute: async <R>() => [] as R }),
      },
    }).db;

    const first = db?.transaction(async () => {
      events.push("first started");
      await firstGate;
      events.push("first finished");
      throw new Error("first failed");
    });
    const second = db?.transaction(async () => {
      events.push("second started");
      return "second";
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toEqual(["first started"]);

    finishFirst();
    await expect(first).rejects.toThrow("first failed");
    await expect(second).resolves.toBe("second");
    expect(events).toEqual(["first started", "first finished", "second started"]);
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

  it.each([
    [{ deadlineMs: 5_000 }, /cron or everyMs/],
    [{ cron: "0 * * * *", everyMs: 60_000, deadlineMs: 5_000 }, /cron or everyMs/],
    [{ everyMs: 1_000, deadlineMs: 5_000 }, /everyMs/],
    [{ cron: "not cron", deadlineMs: 5_000 }, /cron/],
    [{ cron: "* * * * * *", deadlineMs: 5_000 }, /cron/],
    [{ everyMs: 60_000, deadlineMs: 10 }, /deadlineMs/],
  ])("refuses the scheduled task options the host refuses: %j", (options, message) => {
    const ctx = createMockIntegrationContext();
    expect(() => ctx.schedule("t", options as never, async () => {})).toThrow(message);
  });

  it("records scheduled tasks and lets a test run one", async () => {
    const ctx = createMockIntegrationContext();
    const handler = vi.fn(async (_run: { signal: AbortSignal }) => {});
    expect(() => ctx.schedule("Bad_Name", { everyMs: 60_000, deadlineMs: 5_000 }, handler)).toThrow(
      /name/,
    );
    ctx.schedule("refresh", { cron: "*/5 * * * *", deadlineMs: 5_000 }, handler);
    ctx.schedule("nightly", { cron: "@daily", deadlineMs: 5_000 }, handler);
    expect(() => ctx.schedule("refresh", { everyMs: 60_000, deadlineMs: 5_000 }, handler)).toThrow(
      /already scheduled/,
    );
    expect(ctx.registered.tasks.map(({ name, options }) => ({ name, options }))).toEqual([
      { name: "refresh", options: { cron: "*/5 * * * *", deadlineMs: 5_000 } },
      { name: "nightly", options: { cron: "@daily", deadlineMs: 5_000 } },
    ]);

    await ctx.runScheduledTask("refresh");
    expect(handler).toHaveBeenCalledWith({ signal: expect.any(AbortSignal) });
    const aborted = AbortSignal.abort();
    await ctx.runScheduledTask("refresh", { signal: aborted });
    expect(handler).toHaveBeenLastCalledWith({ signal: aborted });
    await expect(ctx.runScheduledTask("missing")).rejects.toThrow(/missing/);
  });
});

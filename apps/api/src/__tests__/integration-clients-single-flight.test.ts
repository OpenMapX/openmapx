import {
  createGeocoderSuggestionProvider,
  runWithProviderDeadline,
} from "@openmapx/integration-framework";
import { createNoopLogger } from "@openmapx/integration-framework/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enturGeocodingService } from "../../../../integrations/geocoding-entur/provider.js";
import { createSwissTransitClient } from "../../../../integrations/transit-opentransportdata-ch/client.js";

const { redisMock, sharedValues, sharedTtls, clearLeases } = vi.hoisted(() => {
  const sharedValues = new Map<string, string>();
  const sharedTtls = new Map<string, number>();
  const clearLeases = new Map<string, number>();
  const redisMock = {
    get: vi.fn(async (key: string) => sharedValues.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      sharedValues.set(key, value);
      return "OK";
    }),
    setex: vi.fn(async (key: string, ttl: number, value: string) => {
      sharedValues.set(key, value);
      sharedTtls.set(key, ttl);
      return "OK";
    }),
    del: vi.fn(async (key: string) => (sharedValues.delete(key) ? 1 : 0)),
    publish: vi.fn(async () => 0),
    eval: vi.fn(async (script: string, keyCount: number, ...args: (string | number)[]) => {
      const [epochKey, key, ...parameters] = args as [string, string, ...(string | number)[]];
      const advance = () => {
        const next = Number(sharedValues.get(epochKey) ?? 0) + 1;
        sharedValues.set(epochKey, String(next));
        return next;
      };
      if (script.startsWith("-- begin-clear")) {
        clearLeases.set(String(parameters[0]), Date.now() + Number(parameters[1]));
        return advance();
      }
      if (script.startsWith("-- finish-clear")) {
        const valid = (clearLeases.get(String(parameters[0])) ?? 0) > Date.now();
        clearLeases.delete(String(parameters[0]));
        advance();
        return valid ? 1 : 0;
      }
      if (script.startsWith("-- renew-clear")) {
        const token = String(parameters[0]);
        if ((clearLeases.get(token) ?? 0) <= Date.now()) return 0;
        clearLeases.set(token, Date.now() + Number(parameters[1]));
        return 1;
      }
      if (keyCount === 3) parameters.shift();
      const [epoch, serialized, ttl] = parameters;
      for (const [token, expiry] of clearLeases)
        if (expiry <= Date.now()) clearLeases.delete(token);
      if (clearLeases.size || (sharedValues.get(epochKey) ?? "0") !== epoch) return 0;
      sharedValues.set(key, String(serialized));
      sharedTtls.set(key, Number(ttl));
      return 1;
    }),
  };
  return { redisMock, sharedValues, sharedTtls, clearLeases };
});

vi.mock("../redis", () => ({ redis: redisMock }));

import { createCacheClient, createHttpClient } from "../integration-clients";
import { cacheInvalidation } from "../services/cache-invalidation";
import { BoundedSingleFlight } from "../utils/bounded-single-flight";
import { httpCacheKey } from "../utils/http-cache-key";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  sharedValues.clear();
  sharedTtls.clear();
  clearLeases.clear();
  vi.clearAllMocks();
  redisMock.get.mockImplementation(async (key: string) => sharedValues.get(key) ?? null);
});
afterEach(() => vi.useRealTimers());

describe("integration cache single-flight", () => {
  it("starts a new withCache flight after clear and prevents the old fill overwriting shared data", async () => {
    const gate = deferred();
    const cache = createCacheClient("clear-race");
    let attempts = 0;
    const load = async () => {
      if (++attempts === 1) {
        await gate.promise;
        return "old";
      }
      return "fresh";
    };
    const first = cache.withCache("value", 60, load);
    await vi.waitFor(() => expect(attempts).toBe(1));
    await cacheInvalidation.invalidate(["int:clear-race:*"], async () => {
      sharedValues.delete("int:clear-race:value");
    });
    const second = cache.withCache("value", 60, load);
    try {
      await vi.waitFor(() => expect(attempts).toBe(2));
      await expect(second).resolves.toBe("fresh");
    } finally {
      gate.resolve();
      await first;
      await second;
    }
    expect(await cache.get("value")).toBe("fresh");
  });

  it("starts a new HTTP flight after clear and prevents old responses refilling shared data", async () => {
    const gate = deferred();
    let attempts = 0;
    vi.stubGlobal("fetch", async () => {
      if (++attempts === 1) {
        await gate.promise;
        return Response.json("old");
      }
      return Response.json("fresh");
    });
    const url = "https://weather.test/clear-race";
    const key = httpCacheKey(url);
    const http = createHttpClient(createNoopLogger());
    const first = http.get(url, { cache: { ttl: 60 } });
    await vi.waitFor(() => expect(attempts).toBe(1));
    await cacheInvalidation.invalidate(["int:http:*"], async () => {
      sharedValues.delete(key);
    });
    const second = http.get(url, { cache: { ttl: 60 } });
    try {
      await vi.waitFor(() => expect(attempts).toBe(2));
      await expect(second).resolves.toBe("fresh");
    } finally {
      gate.resolve();
      await first;
      await second;
    }
    expect(JSON.parse(sharedValues.get(key) ?? "null")).toBe("fresh");
  });

  it("does not publish a loader that ignores cancellation after all callers leave", async () => {
    const gate = deferred();
    const cache = createCacheClient("cancel-race");
    const controller = new AbortController();
    let started = false;
    const first = cache.withCache(
      "value",
      60,
      async () => {
        started = true;
        await gate.promise;
        return "abandoned";
      },
      controller.signal,
    );
    await vi.waitFor(() => expect(started).toBe(true));
    controller.abort(new Error("caller left"));
    await expect(first).rejects.toThrow("caller left");
    gate.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(await cache.get("value")).toBe(null);
  });

  it("forwards scoped invalidations and releases the subscription", async () => {
    const cache = createCacheClient("notifications");
    const events: boolean[] = [];
    const unsubscribe = cache.onInvalidate?.((event) => events.push(event.available));
    await cacheInvalidation.invalidate(["int:notifications:*"], async () => undefined);
    expect(events).toEqual([false, false, false]);
    unsubscribe?.();
    await cacheInvalidation.invalidate(["int:*"], async () => undefined);
    expect(events).toEqual([false, false, false]);
  });

  it.each([undefined, 60])("blocks direct cache.set during a clear with TTL %s", async (ttl) => {
    const cache = createCacheClient("direct-set");
    await cacheInvalidation.invalidate(["int:direct-set:*"], async () => {
      await cache.set("value", "during", ttl);
      expect(await cache.get("value")).toBe(null);
    });
    await cache.set("value", "after", ttl);
    expect(await cache.get("value")).toBe("after");
    expect(sharedTtls.get("int:direct-set:value")).toBe(ttl ?? 0);
  });

  it.each(["cache", "http"] as const)(
    "continues %s acquisition after a shared read stops replying",
    async (mode) => {
      vi.useFakeTimers();
      redisMock.get.mockImplementation(async (key: string) => {
        if (key.startsWith("openmapx:")) return sharedValues.get(key) ?? null;
        return new Promise<never>(() => {});
      });
      vi.stubGlobal("fetch", async () => Response.json("fresh"));
      const work =
        mode === "cache"
          ? createCacheClient("read-timeout").withCache("value", 60, async () => "fresh")
          : createHttpClient(createNoopLogger()).get("https://weather.test/read-timeout", {
              cache: { ttl: 60 },
            });
      let completed = false;
      void work.then(() => {
        completed = true;
      });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(completed).toBe(true);
      expect(await work).toBe("fresh");
    },
  );

  it("runs one provider operation for concurrent misses of the same integration key", async () => {
    const gate = deferred();
    let executions = 0;
    const load = async () => {
      const attempt = ++executions;
      await gate.promise;
      return { attempt };
    };
    const cache = createCacheClient("weather");

    const first = cache.withCache("forecast:berlin", 60, load);
    const second = cache.withCache("forecast:berlin", 60, load);
    await vi.waitFor(() => expect(executions).toBeGreaterThan(0));
    gate.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual([{ attempt: 1 }, { attempt: 1 }]);
    expect(executions).toBe(1);
  });

  it("keeps an integration cache fill alive for remaining callers when the owner disconnects", async () => {
    const gate = deferred();
    const firstController = new AbortController();
    const secondController = new AbortController();
    let executions = 0;
    let operationSignal: AbortSignal | undefined;
    const cache = createCacheClient("search-suggestions");
    const load = async (signal: AbortSignal) => {
      executions += 1;
      operationSignal = signal;
      await gate.promise;
      return { suggestions: ["complete"] };
    };

    const first = cache.withCache("berlin", 300, load, firstController.signal);
    const second = cache.withCache("berlin", 300, load, secondController.signal);
    await vi.waitFor(() => expect(operationSignal).toBeDefined());

    firstController.abort(new Error("first caller left"));

    await expect(first).rejects.toThrow("first caller left");
    expect(operationSignal?.aborted).toBe(false);
    gate.resolve();
    await expect(second).resolves.toEqual({ suggestions: ["complete"] });
    expect(executions).toBe(1);
    expect(sharedValues.get("int:search-suggestions:berlin")).toBe(
      JSON.stringify({ suggestions: ["complete"] }),
    );
  });

  it("removes a rejected integration flight so a later request can retry", async () => {
    let executions = 0;
    const cache = createCacheClient("weather");
    const load = async () => {
      executions += 1;
      if (executions === 1) throw new Error("provider unavailable");
      return "recovered";
    };

    await expect(cache.withCache("alerts", 60, load)).rejects.toThrow("provider unavailable");
    await expect(cache.withCache("alerts", 60, load)).resolves.toBe("recovered");
    expect(executions).toBe(2);
  });

  it("jitters longer integration-cache TTLs to avoid synchronized expiry", async () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    const cache = createCacheClient("weather");

    await cache.withCache("reference-data", 300, async () => "fresh");

    expect(sharedValues.get("int:weather:reference-data")).toBe(JSON.stringify("fresh"));
    expect(sharedTtls.get("int:weather:reference-data")).toBe(330);
  });

  it("returns degraded values without publishing them to the shared cache", async () => {
    const cache = createCacheClient("search-suggestions");
    const partial = { suggestions: ["available"], partial: true };

    await expect(
      cache.withCache(
        "berlin",
        300,
        async () => partial,
        undefined,
        (value) => !value.partial,
      ),
    ).resolves.toEqual(partial);

    expect(sharedValues.has("int:search-suggestions:berlin")).toBe(false);
  });

  it("evicts a previously cached degraded value when a cache policy rejects it", async () => {
    sharedValues.set(
      "int:search-suggestions:berlin",
      JSON.stringify({ suggestions: ["stale-partial"], partial: true }),
    );
    const cache = createCacheClient("search-suggestions");
    const load = vi.fn(async () => ({ suggestions: ["complete"], partial: false }));

    await expect(
      cache.withCache("berlin", 300, load, undefined, (value) => !value.partial),
    ).resolves.toEqual({ suggestions: ["complete"], partial: false });

    expect(redisMock.del).toHaveBeenCalledWith("int:search-suggestions:berlin");
    expect(load).toHaveBeenCalledTimes(1);
    expect(sharedValues.get("int:search-suggestions:berlin")).toBe(
      JSON.stringify({ suggestions: ["complete"], partial: false }),
    );
  });

  it("performs one upstream GET for concurrent HTTP-cache misses", async () => {
    const gate = deferred();
    let fetches = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const attempt = ++fetches;
        await gate.promise;
        return new Response(JSON.stringify({ attempt }), {
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    const http = createHttpClient(createNoopLogger());

    const first = http.get<{ attempt: number }>("https://weather.test/forecast", {
      cache: { ttl: 60 },
    });
    const second = http.get<{ attempt: number }>("https://weather.test/forecast", {
      cache: { ttl: 60 },
    });
    await vi.waitFor(() => expect(fetches).toBeGreaterThan(0));
    gate.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual([{ attempt: 1 }, { attempt: 1 }]);
    expect(fetches).toBe(1);
  });

  it("keeps shared HTTP work alive when only one waiting caller cancels", async () => {
    const gate = deferred();
    let fetches = 0;
    let upstreamSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        fetches += 1;
        upstreamSignal = init?.signal ?? undefined;
        await Promise.race([
          gate.promise,
          new Promise<never>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
              once: true,
            });
          }),
        ]);
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    const http = createHttpClient(createNoopLogger());
    const firstController = new AbortController();
    const secondController = new AbortController();

    const first = http.get("https://weather.test/forecast", {
      cache: { ttl: 60 },
      signal: firstController.signal,
    });
    const second = http.get("https://weather.test/forecast", {
      cache: { ttl: 60 },
      signal: secondController.signal,
    });
    await vi.waitFor(() => expect(fetches).toBeGreaterThan(0));
    firstController.abort(new Error("first caller left"));

    await expect(first).rejects.toThrow("first caller left");
    expect(upstreamSignal?.aborted).toBe(false);
    gate.resolve();
    await expect(second).resolves.toEqual({ ok: true });
    expect(fetches).toBe(1);
  });

  it("aborts shared HTTP work after its last waiting caller cancels", async () => {
    let upstreamSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            upstreamSignal = init?.signal ?? undefined;
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
              once: true,
            });
          }),
      ),
    );
    const http = createHttpClient(createNoopLogger());
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = http.get("https://weather.test/forecast", {
      cache: { ttl: 60 },
      signal: firstController.signal,
    });
    const second = http.get("https://weather.test/forecast", {
      cache: { ttl: 60 },
      signal: secondController.signal,
    });
    await vi.waitFor(() => expect(upstreamSignal).toBeDefined());

    firstController.abort(new Error("first caller left"));
    secondController.abort(new Error("second caller left"));

    await expect(first).rejects.toThrow("first caller left");
    await expect(second).rejects.toThrow("second caller left");
    await vi.waitFor(() => expect(upstreamSignal?.aborted).toBe(true));
  });

  it("bypasses coalescing rather than tracking more than the configured flight bound", async () => {
    const gate = deferred();
    const singleFlight = new BoundedSingleFlight(1);
    let secondKeyExecutions = 0;
    const firstKey = singleFlight.run("first", async () => {
      await gate.promise;
      return "first";
    });
    const secondKeyA = singleFlight.run("second", async () => {
      secondKeyExecutions += 1;
      await gate.promise;
      return "second";
    });
    const secondKeyB = singleFlight.run("second", async () => {
      secondKeyExecutions += 1;
      await gate.promise;
      return "second";
    });
    await vi.waitFor(() => expect(secondKeyExecutions).toBe(2));
    gate.resolve();

    await expect(Promise.all([firstKey, secondKeyA, secondKeyB])).resolves.toEqual([
      "first",
      "second",
      "second",
    ]);
  });
});

describe("geocoder suggestion shared cache ownership", () => {
  it.each(["survivor", "all-cancelled"] as const)(
    "preserves owner cancellation semantics with a real Entur adapter: %s",
    async (mode) => {
      let downstreamSignal: AbortSignal | undefined;
      let release!: () => void;
      const started = deferred();
      const fetch = vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((resolve) => {
            downstreamSignal = init?.signal ?? undefined;
            release = () => resolve(Response.json({ features: [] }));
            started.resolve();
          }),
      );
      vi.stubGlobal("fetch", fetch);
      const provider = createGeocoderSuggestionProvider({
        id: "geocoding-entur",
        geocoder: enturGeocodingService,
        attributions: () => [],
      });
      const cache = createCacheClient("search-suggestions");
      const load = (signal: AbortSignal) =>
        runWithProviderDeadline(
          (context) => provider.searchSuggestions({ query: "Oslo", lang: "en", limit: 8 }, context),
          { signal, timeoutMs: 1_000 },
        );
      const firstController = new AbortController();
      const secondController = new AbortController();
      const first = cache.withCache("oslo", 300, load, firstController.signal);
      const second = cache.withCache("oslo", 300, load, secondController.signal);
      const firstOutcome = first.catch((error: Error) => error);
      const secondOutcome = second.catch((error: Error) => error);
      await started.promise;
      try {
        firstController.abort(new Error("first caller left"));
        expect(await firstOutcome).toMatchObject({ message: "first caller left" });
        expect(downstreamSignal?.aborted).toBe(false);
        if (mode === "all-cancelled") {
          secondController.abort(new Error("second caller left"));
          expect(await secondOutcome).toMatchObject({ message: "second caller left" });
          expect(downstreamSignal?.aborted).toBe(true);
          expect(sharedValues.has("int:search-suggestions:oslo")).toBe(false);
        } else {
          release();
          await expect(second).resolves.toMatchObject({ suggestions: [] });
          expect(
            JSON.parse(sharedValues.get("int:search-suggestions:oslo") ?? "null"),
          ).toMatchObject({ suggestions: [] });
        }
        expect(fetch).toHaveBeenCalledTimes(1);
      } finally {
        release();
        await Promise.all([firstOutcome, secondOutcome]);
      }
      if (mode === "all-cancelled") {
        fetch.mockImplementationOnce(async () => Response.json({ features: [] }));
        await expect(cache.withCache("oslo", 300, load)).resolves.toMatchObject({
          suggestions: [],
        });
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(JSON.parse(sharedValues.get("int:search-suggestions:oslo") ?? "null")).toMatchObject(
          { suggestions: [] },
        );
      }
    },
  );
});

describe("without Redis", () => {
  it("starts new work after local invalidation instead of joining the old flight", async () => {
    vi.resetModules();
    vi.doMock("../redis", () => ({ redis: null }));
    try {
      const { createCacheClient: createLocalCache } = await import("../integration-clients");
      const { cacheInvalidation: localInvalidation } = await import(
        "../services/cache-invalidation"
      );
      const cache = createLocalCache("local-clear-race");
      const gate = deferred();
      let attempts = 0;
      const load = async () => {
        if (++attempts === 1) {
          await gate.promise;
          return "old";
        }
        return "fresh";
      };
      const first = cache.withCache("value", 60, load);
      await vi.waitFor(() => expect(attempts).toBe(1));
      await localInvalidation.invalidate(["int:local-clear-race:*"], async () => undefined);
      const second = cache.withCache("value", 60, load);
      try {
        await vi.waitFor(() => expect(attempts).toBe(2));
        await expect(second).resolves.toBe("fresh");
      } finally {
        gate.resolve();
        await Promise.all([first, second]);
      }
    } finally {
      vi.doUnmock("../redis");
      vi.resetModules();
    }
  });
});

describe("acquisition-scoped cache writers", () => {
  it("rejects derived writes from before a clear and retains a fixed integration scope", async () => {
    const cache = createCacheClient("derived");
    const writer = await cache.captureWriter?.();
    if (!writer) throw new Error("managed cache writer missing");
    await writer.set("route", "before", 60);
    expect(await cache.get("route")).toBe("before");
    await cacheInvalidation.invalidate(["int:derived:*"], async () => {
      sharedValues.delete("int:derived:route");
    });
    await writer.set("route", "late", 60);
    expect(await cache.get("route")).toBeNull();
    const current = await cache.captureWriter?.();
    await current?.set("route", "fresh", 30);
    expect(await cache.get("route")).toBe("fresh");
    expect(sharedTtls.get("int:derived:route")).toBe(30);
  });

  it("never recaptures authorization after a failed epoch capture", async () => {
    const cache = createCacheClient("failed-capture");
    redisMock.get.mockRejectedValueOnce(new Error("Redis unavailable"));
    const writer = await cache.captureWriter?.();
    if (!writer) throw new Error("managed cache writer missing");
    await writer.set("route", "late", 60);
    expect(await cache.get("route")).toBeNull();
    expect(redisMock.eval).not.toHaveBeenCalled();
  });
});

it("retiring Swiss A leaves an identical shared acquisition alive for Swiss B", async () => {
  const gate = deferred();
  const quota = vi.fn(async () => ({ allowed: true, remaining: {}, retryAt: null }));
  const runtime = {
    read: async () => ({ state: "miss" as const }),
    write: async () => {},
    acquireLease: async () => ({ token: "test" }),
    releaseLease: async () => {},
    consumeQuota: quota,
  };
  const cache = createCacheClient("swiss-shared-retirement");
  const http = createHttpClient(createNoopLogger());
  const options = {
    config: { apiKey: "same-key" },
    contributors: {},
    http,
    cache,
    upstreamRuntime: runtime,
  };
  const first = createSwissTransitClient(options);
  const second = createSwissTransitClient(options);
  let acquisitionSignal: AbortSignal | null | undefined;
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    acquisitionSignal = init?.signal;
    await gate.promise;
    return Response.json({ generation: "shared" });
  });
  vi.stubGlobal("fetch", fetch);
  const run = vi.spyOn(BoundedSingleFlight.prototype, "run");
  const request = { evu: "SBBP", operationDate: "2025-02-03", trainNumber: "419" };
  const pendingA = first.fetchSwissFormationJourney(request);
  const rejectedA = expect(pendingA).rejects.toThrow(/retired/);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  const pendingB = second.fetchSwissFormationJourney(request);
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  await first.dispose();
  await rejectedA;
  expect(acquisitionSignal?.aborted).toBe(false);
  gate.resolve();
  expect(await pendingB).toEqual({ generation: "shared" });
  expect(fetch).toHaveBeenCalledOnce();
  expect(quota).toHaveBeenCalledOnce();
  await second.dispose();
});

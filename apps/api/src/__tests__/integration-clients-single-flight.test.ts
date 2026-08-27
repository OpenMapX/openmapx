import { createNoopLogger } from "@openmapx/integration-framework/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { redisMock } = vi.hoisted(() => ({
  redisMock: {
    get: vi.fn(),
    set: vi.fn(),
    setex: vi.fn(),
    del: vi.fn(),
  },
}));

vi.mock("../redis", () => ({ redis: redisMock }));

import { createCacheClient, createHttpClient } from "../integration-clients";
import { BoundedSingleFlight } from "../utils/bounded-single-flight";

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
  redisMock.get.mockReset().mockResolvedValue(null);
  redisMock.set.mockReset().mockResolvedValue("OK");
  redisMock.setex.mockReset().mockResolvedValue("OK");
  redisMock.del.mockReset().mockResolvedValue(1);
});

describe("integration cache single-flight", () => {
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
    expect(redisMock.setex).toHaveBeenCalledWith(
      "int:search-suggestions:berlin",
      expect.any(Number),
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

    expect(redisMock.setex).toHaveBeenCalledWith(
      "int:weather:reference-data",
      330,
      JSON.stringify("fresh"),
    );
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

    expect(redisMock.setex).not.toHaveBeenCalled();
  });

  it("evicts a previously cached degraded value when a cache policy rejects it", async () => {
    redisMock.get.mockResolvedValueOnce(
      JSON.stringify({ suggestions: ["stale-partial"], partial: true }),
    );
    const cache = createCacheClient("search-suggestions");
    const load = vi.fn(async () => ({ suggestions: ["complete"], partial: false }));

    await expect(
      cache.withCache("berlin", 300, load, undefined, (value) => !value.partial),
    ).resolves.toEqual({ suggestions: ["complete"], partial: false });

    expect(redisMock.del).toHaveBeenCalledWith("int:search-suggestions:berlin");
    expect(load).toHaveBeenCalledTimes(1);
    expect(redisMock.setex).toHaveBeenCalledWith(
      "int:search-suggestions:berlin",
      expect.any(Number),
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

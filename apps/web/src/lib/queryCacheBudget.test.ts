import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import {
  collectHighCardinalityQueryCacheMetrics,
  installHighCardinalityQueryCacheBudget,
  pruneHighCardinalityQueryCache,
} from "./queryCacheBudget";

describe("high-cardinality query cache budget", () => {
  it("evicts the oldest inactive entries until count and byte budgets are met", () => {
    const client = new QueryClient();
    for (let index = 0; index < 6; index++) {
      client.setQueryData(["autocomplete", `query-${index}`], { value: "x".repeat(100) });
    }

    const result = pruneHighCardinalityQueryCache(client, {
      maxInactiveEntries: 3,
      maxEstimatedBytes: 1_000,
    });

    expect(result.removed).toBe(3);
    expect(result.after.inactiveCount).toBe(3);
    expect(client.getQueryData(["autocomplete", "query-0"])).toBeUndefined();
    expect(client.getQueryData(["autocomplete", "query-5"])).toBeDefined();
  });

  it("never evicts active queries and reports estimated payload bytes", () => {
    const client = new QueryClient();
    client.setQueryData(["category-search", "active"], { value: "x".repeat(1_000) });
    client.setQueryData(["category-search", "inactive"], { value: "y".repeat(1_000) });
    const observer = new QueryObserver(client, {
      queryKey: ["category-search", "active"],
      enabled: false,
    });
    const unsubscribe = observer.subscribe(() => {});

    const before = collectHighCardinalityQueryCacheMetrics(client);
    const result = pruneHighCardinalityQueryCache(client, {
      maxInactiveEntries: 0,
      maxEstimatedBytes: 1,
    });

    expect(before.estimatedBytes).toBeGreaterThan(1_000);
    expect(result.after.activeCount).toBe(1);
    expect(client.getQueryData(["category-search", "active"])).toBeDefined();
    expect(client.getQueryData(["category-search", "inactive"])).toBeUndefined();
    unsubscribe();
  });

  it("ignores low-cardinality metadata queries", () => {
    const client = new QueryClient();
    client.setQueryData(["capabilities"], { value: "x".repeat(10_000) });

    expect(collectHighCardinalityQueryCacheMetrics(client)).toEqual({
      activeCount: 0,
      inactiveCount: 0,
      estimatedBytes: 0,
    });
  });
});

describe("offline retention interaction", () => {
  it("exempts persisted recent-map-data queries from the budget while retention is on", async () => {
    const { configureOfflineQueryRetention } = await import("@openmapx/core");
    const { QueryClient } = await import("@tanstack/react-query");
    const { pruneHighCardinalityQueryCache } = await import("./queryCacheBudget");
    const client = new QueryClient();
    for (let i = 0; i < 5; i++) {
      client.setQueryData(["place", `id-${i}`], { i });
      client.setQueryData(["autocomplete", `q-${i}`], { i });
    }
    try {
      configureOfflineQueryRetention(true);
      const result = pruneHighCardinalityQueryCache(client, {
        maxInactiveEntries: 0,
        maxEstimatedBytes: 0,
      });
      expect(result.removed).toBe(5);
      expect(client.getQueryCache().findAll({ queryKey: ["place"] })).toHaveLength(5);
      expect(client.getQueryCache().findAll({ queryKey: ["autocomplete"] })).toHaveLength(0);
    } finally {
      configureOfflineQueryRetention(false);
    }
  });
});

describe("incremental measurement", () => {
  it("does not revisit unchanged payloads during pruning or observer transitions", () => {
    const client = new QueryClient({ defaultOptions: { queries: { structuralSharing: false } } });
    let reads = 0;
    const data = {
      get value() {
        reads++;
        return "payload";
      },
    };
    client.setQueryData(["autocomplete", "a"], data);
    const budget = { maxInactiveEntries: 10, maxEstimatedBytes: 10_000 };
    pruneHighCardinalityQueryCache(client, budget);
    reads = 0;
    pruneHighCardinalityQueryCache(client, budget);
    const observer = new QueryObserver(client, { queryKey: ["autocomplete", "a"], enabled: false });
    const stop = observer.subscribe(() => {});
    expect(pruneHighCardinalityQueryCache(client, budget).after.activeCount).toBe(1);
    stop();
    expect(pruneHighCardinalityQueryCache(client, budget).after.inactiveCount).toBe(1);
    expect(reads).toBe(0);
    client.setQueryData(["autocomplete", "b"], {
      get value() {
        reads++;
        return "new";
      },
    });
    pruneHighCardinalityQueryCache(client, budget);
    expect(reads).toBe(1);
    client.setQueryData(["autocomplete", "a"], {
      get value() {
        reads++;
        return "replacement";
      },
    });
    pruneHighCardinalityQueryCache(client, budget);
    expect(reads).toBe(2);
    client.clear();
  });

  it("refines truncated estimates for larger budgets and exact diagnostics", () => {
    const client = new QueryClient();
    const cycle: Record<string, unknown> = {
      bytes: new Uint8Array(100),
      values: ["x".repeat(200)],
    };
    cycle.self = cycle;
    client.setQueryData(["autocomplete"], cycle);
    const observer = new QueryObserver(client, { queryKey: ["autocomplete"], enabled: false });
    const stop = observer.subscribe(() => {});
    const small = pruneHighCardinalityQueryCache(client, {
      maxInactiveEntries: 0,
      maxEstimatedBytes: 1,
    });
    const large = pruneHighCardinalityQueryCache(client, {
      maxInactiveEntries: 0,
      maxEstimatedBytes: 10_000,
    });
    expect(small.after.estimatedBytes).toBe(small.before.estimatedBytes);
    expect(large.after.estimatedBytes).toBe(562);
    expect(collectHighCardinalityQueryCacheMetrics(client).estimatedBytes).toBe(562);
    stop();
    expect(
      pruneHighCardinalityQueryCache(client, { maxInactiveEntries: 0, maxEstimatedBytes: 0 }).after
        .estimatedBytes,
    ).toBe(0);
    client.clear();
  });
});

it("coalesces relevant events, ignores metadata, and cancels disposal timers", () => {
  vi.useFakeTimers();
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  const timers = vi.spyOn(globalThis, "setTimeout");
  const clears = vi.spyOn(globalThis, "clearTimeout");
  const dispose = installHighCardinalityQueryCacheBudget(client);
  try {
    for (let i = 0; i < 205; i++) client.setQueryData(["autocomplete", i], i);
    expect(timers).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(client.getQueryCache().getAll()).toHaveLength(200);
    expect(timers).toHaveBeenCalledTimes(1);
    client.setQueryData(["capabilities"], {});
    expect(timers).toHaveBeenCalledTimes(1);
    client.setQueryData(["autocomplete", "next"], 1);
    expect(timers).toHaveBeenCalledTimes(2);
    dispose();
    expect(clears).toHaveBeenCalled();
  } finally {
    dispose();
    client.clear();
    timers.mockRestore();
    clears.mockRestore();
    vi.useRealTimers();
  }
});

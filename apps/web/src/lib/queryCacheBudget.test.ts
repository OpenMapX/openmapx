import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
  collectHighCardinalityQueryCacheMetrics,
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

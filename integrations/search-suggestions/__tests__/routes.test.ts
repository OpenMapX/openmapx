import type { CacheClient } from "@openmapx/integration-framework";
import {
  createMockIntegrationContext,
  nth,
  routeRequest,
} from "@openmapx/integration-framework/testing";
import { describe, expect, it, vi } from "vitest";
import { setup } from "../index.js";

function reply() {
  const send = vi.fn();
  return {
    send,
    status: vi.fn(() => ({ send })),
    header: vi.fn(),
    type: vi.fn(),
  };
}

describe("search suggestions route", () => {
  it("returns an empty response for a one-character query", async () => {
    const ctx = createMockIntegrationContext();
    setup(ctx);
    const res = reply();
    await nth(ctx.registered.routes, 0).handler(routeRequest({ query: { q: "F" } }), res);
    expect(res.send).toHaveBeenCalledWith({
      suggestions: [],
      attributions: [],
      partial: false,
    });
  });

  it("rejects incomplete proximity", async () => {
    const ctx = createMockIntegrationContext();
    setup(ctx);
    const res = reply();
    await nth(ctx.registered.routes, 0).handler(
      routeRequest({ query: { q: "FRA", lat: "50" } }),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("marks degraded aggregate responses as non-cacheable", async () => {
    const degraded = {
      suggestions: [{ id: "available", name: "Available" }],
      attributions: [],
      partial: true,
    };
    const calls: Array<{ key: string; ttlSeconds: number; callerSignal?: AbortSignal }> = [];
    const cacheVerdicts: Array<{ degraded?: boolean; complete?: boolean }> = [];
    const withCache: CacheClient["withCache"] = async <T>(
      key: string,
      ttlSeconds: number,
      _load: (operationSignal: AbortSignal) => Promise<T>,
      callerSignal?: AbortSignal,
      shouldCache?: (value: T) => boolean,
    ) => {
      calls.push({ key, ttlSeconds, callerSignal });
      // The cache answers with a canned aggregate in place of the route's own load,
      // and records how the route's cache predicate judges it and its complete twin.
      const answer = degraded as T;
      cacheVerdicts.push({
        degraded: shouldCache?.(answer),
        complete: shouldCache?.({ ...degraded, partial: false } as T),
      });
      return answer;
    };
    const ctx = createMockIntegrationContext({
      cache: {
        get: async () => null,
        set: async () => undefined,
        del: async () => undefined,
        withCache,
      },
    });
    setup(ctx);
    const res = reply();

    await nth(ctx.registered.routes, 0).handler(routeRequest({ query: { q: "Berlin" } }), res);

    expect(res.header).toHaveBeenCalledWith("Cache-Control", "no-store");
    expect(calls).toEqual([{ key: expect.any(String), ttlSeconds: 300, callerSignal: undefined }]);
    expect(cacheVerdicts).toEqual([{ degraded: false, complete: true }]);
  });
});

import type { AutocompleteResult, IntegrationContext } from "@openmapx/integration-framework";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { describe, expect, it, vi } from "vitest";
import { setup } from "../index.js";
import type { GeocodingProvider } from "../types.js";

function reply() {
  const send = vi.fn();
  return {
    send,
    status: vi.fn(() => ({ send })),
    header: vi.fn(),
    type: vi.fn(),
  };
}

const CAFE: AutocompleteResult = { id: "cafe", label: "Café", type: "poi" };

function harness() {
  const autocomplete = vi.fn<GeocodingProvider["autocomplete"]>(async () => [{ ...CAFE }]);
  const provider: GeocodingProvider = {
    geocode: async () => [],
    autocomplete,
    reverseGeocode: async () => null,
  };
  const cacheKeys: string[] = [];
  const ctx = createMockIntegrationContext({
    config: { provider: "maptiler" },
    cache: {
      get: async () => null,
      set: async () => undefined,
      del: async () => undefined,
      withCache: async (key, _ttl, fn) => {
        cacheKeys.push(key);
        return fn(new AbortController().signal);
      },
    },
  });
  const integrations = [
    { id: "geocoding-maptiler", providers: new Map([["geocoding", [provider]]]) },
  ] as unknown as ReturnType<IntegrationContext["getIntegrationsByDomain"]>;
  ctx.getIntegrationsByDomain = () => integrations;
  setup(ctx);
  const route = ctx.registered.routes.find((r) => r.path === "/autocomplete");
  if (!route) throw new Error("autocomplete route not registered");
  const call = async (query: Record<string, string>) => {
    const res = reply();
    await route.handler({ query, params: {}, body: undefined, headers: {} }, res);
    return res;
  };
  return { autocomplete, cacheKeys, call };
}

describe("geocoding autocomplete route", () => {
  it("rejects half-supplied or invalid coordinates", async () => {
    const { autocomplete, call } = harness();

    const invalid: Record<string, string>[] = [
      { q: "coffee", lat: "52.52" },
      { q: "coffee", lng: "13.4" },
      { q: "coffee", lat: "abc", lng: "13.4" },
      { q: "coffee", lat: "91", lng: "13.4" },
    ];
    for (const query of invalid) {
      const res = await call(query);
      expect(res.status).toHaveBeenCalledWith(400);
    }
    expect(autocomplete).not.toHaveBeenCalled();
  });

  it("passes the rounded location and floored zoom upstream", async () => {
    const { autocomplete, call } = harness();

    await call({ q: "bias-forward", lang: "de", lat: "52.52049", lng: "13.40471", zoom: "13.8" });

    expect(autocomplete).toHaveBeenCalledWith("bias-forward", "de", {
      proximity: [13.4, 52.52],
      zoom: 13,
    });
  });

  it("drops an unusable zoom but keeps the point bias", async () => {
    const { autocomplete, cacheKeys, call } = harness();

    await call({ q: "bias-zoom", lat: "52.52", lng: "13.4", zoom: "abc" });
    await call({ q: "bias-zoom", lat: "52.52", lng: "13.4", zoom: "-1" });

    expect(autocomplete).toHaveBeenCalledTimes(1);
    expect(autocomplete).toHaveBeenCalledWith("bias-zoom", "en", { proximity: [13.4, 52.52] });
    expect(cacheKeys).toHaveLength(1);
  });

  it("keys the cache by rounded location and zoom so answers never cross locations", async () => {
    const { autocomplete, cacheKeys, call } = harness();

    // Same 0.01° cell: second request is served from the in-process cache.
    await call({ q: "bias-cache", lat: "52.5201", lng: "13.4049" });
    await call({ q: "bias-cache", lat: "52.5249", lng: "13.4001" });
    expect(autocomplete).toHaveBeenCalledTimes(1);

    // Different cell, different zoom, and no bias each get their own slot.
    await call({ q: "bias-cache", lat: "48.14", lng: "11.58" });
    await call({ q: "bias-cache", lat: "52.52", lng: "13.4", zoom: "10" });
    await call({ q: "bias-cache" });
    expect(autocomplete).toHaveBeenCalledTimes(4);
    expect(new Set(cacheKeys).size).toBe(4);
    expect(autocomplete.mock.calls.map((c) => c[2])).toEqual([
      { proximity: [13.4, 52.52] },
      { proximity: [11.58, 48.14] },
      { proximity: [13.4, 52.52], zoom: 10 },
      undefined,
    ]);
  });
});

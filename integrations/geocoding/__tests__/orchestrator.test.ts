import type { IntegrationContext } from "@openmapx/integration-framework";
import { describe, expect, it } from "vitest";
import { getGeocodingProvider, setConfiguredProviderList } from "../orchestrator.js";
import type { GeocodingProvider, SearchResult } from "../types.js";

function result(id: string): SearchResult {
  return { id, label: id, coordinates: [0, 0], type: "poi", confidence: 1 };
}

function provider(search: SearchResult[]): GeocodingProvider {
  return {
    geocode: async () => search.map((r) => ({ ...r })),
    autocomplete: async () =>
      search.map((r) => ({ id: r.id, label: r.label, type: "poi" as const })),
    reverseGeocode: async () => (search.length ? { address: "a", city: "c" } : null),
  };
}

function ctxWith(integrations: Array<[string, GeocodingProvider]>): IntegrationContext {
  const list = integrations.map(([id, p]) => ({
    id,
    providers: new Map<string, GeocodingProvider[]>([["geocoding", [p]]]),
  }));
  return { getIntegrationsByDomain: () => list } as unknown as IntegrationContext;
}

describe("geocoding orchestrator served-provider tagging", () => {
  it("tags single-provider results with the serving integration id", async () => {
    setConfiguredProviderList("maptiler");
    const ctx = ctxWith([["geocoding-maptiler", provider([result("a")])]]);
    const results = await getGeocodingProvider(ctx).geocode("q");
    expect(results.map((r) => r.provider)).toEqual(["geocoding-maptiler"]);
  });

  it("credits the provider that actually produced results, not the first in the chain", async () => {
    setConfiguredProviderList("maptiler,photon");
    const ctx = ctxWith([
      ["geocoding-maptiler", provider([])], // empty → falls through
      ["geocoding-photon", provider([result("b")])],
    ]);
    const results = await getGeocodingProvider(ctx).geocode("q");
    expect(results).toHaveLength(1);
    expect(results[0].provider).toBe("geocoding-photon");
  });

  it("tags autocomplete suggestions with the serving integration id", async () => {
    setConfiguredProviderList("maptiler");
    const ctx = ctxWith([["geocoding-maptiler", provider([result("a")])]]);
    const suggestions = await getGeocodingProvider(ctx).autocomplete("q");
    expect(suggestions.every((s) => s.provider === "geocoding-maptiler")).toBe(true);
  });

  it("tags reverse-geocode results with the serving integration id", async () => {
    setConfiguredProviderList("maptiler");
    const ctx = ctxWith([["geocoding-maptiler", provider([result("a")])]]);
    const res = await getGeocodingProvider(ctx).reverseGeocode(0, 0);
    expect(res?.provider).toBe("geocoding-maptiler");
  });
});

import type { IntegrationContext } from "@openmapx/integration-framework";
import { licensingFromDeclaration } from "@openmapx/mobility-core/licensing";
import { describe, expect, it, vi } from "vitest";
import { getGeocodingProvider } from "../orchestrator.js";
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

function ctxWith(
  integrations: Array<[string, GeocodingProvider]>,
  order = "maptiler",
): IntegrationContext {
  const list = integrations.map(([id, p]) => ({
    id,
    providers: new Map<string, GeocodingProvider[]>([["geocoding", [p]]]),
  }));
  return {
    config: { provider: order },
    getIntegrationsByDomain: () => list,
  } as unknown as IntegrationContext;
}

describe("geocoding orchestrator served-provider tagging", () => {
  it("tags single-provider results with the serving integration id", async () => {
    const ctx = ctxWith([["geocoding-maptiler", provider([result("a")])]]);
    const results = await getGeocodingProvider(ctx).geocode("q");
    expect(results.map((r) => r.provider)).toEqual(["geocoding-maptiler"]);
  });

  it("credits the provider that actually produced results, not the first in the chain", async () => {
    const ctx = ctxWith(
      [
        ["geocoding-maptiler", provider([])], // empty → falls through
        ["geocoding-photon", provider([result("b")])],
      ],
      "maptiler,photon",
    );
    const results = await getGeocodingProvider(ctx).geocode("q");
    expect(results).toHaveLength(1);
    expect(results[0].provider).toBe("geocoding-photon");
  });

  it("tags autocomplete suggestions with the serving integration id", async () => {
    const ctx = ctxWith([["geocoding-maptiler", provider([result("a")])]]);
    const suggestions = await getGeocodingProvider(ctx).autocomplete("q");
    expect(suggestions.every((s) => s.provider === "geocoding-maptiler")).toBe(true);
  });

  it("forwards the location bias through the fallback chain", async () => {
    const empty = provider([]);
    const served = provider([result("b")]);
    const emptySpy = vi.spyOn(empty, "autocomplete");
    const servedSpy = vi.spyOn(served, "autocomplete");
    const ctx = ctxWith(
      [
        ["geocoding-maptiler", empty],
        ["geocoding-photon", served],
      ],
      "maptiler,photon",
    );
    const bias = { proximity: [13.4, 52.52] as [number, number], zoom: 12 };
    await getGeocodingProvider(ctx).autocomplete("coffee", "de", bias);
    expect(emptySpy).toHaveBeenCalledWith("coffee", "de", bias);
    expect(servedSpy).toHaveBeenCalledWith("coffee", "de", bias);
  });

  it("tags reverse-geocode results with the serving integration id", async () => {
    const ctx = ctxWith([["geocoding-maptiler", provider([result("a")])]]);
    const res = await getGeocodingProvider(ctx).reverseGeocode(0, 0);
    expect(res?.provider).toBe("geocoding-maptiler");
  });
});

it("captures only selected backend credits before cache and does not mutate provider-owned records", async () => {
  const raw = { ...result("cached"), sourceIds: ["selected"] };
  const selected = {
    sourceId: "selected",
    name: "Captured selected",
    url: "https://selected.example",
    licensing: licensingFromDeclaration("CC0-1.0", undefined),
  };
  const sources = [selected, { ...selected, sourceId: "inactive", name: "Missing key backend" }];
  const ctx = {
    config: { provider: "photon" },
    getIntegrationsByDomain: () => [
      {
        id: "geocoding-photon",
        manifest: { dataSources: sources },
        providers: new Map([
          [
            "geocoding",
            [
              {
                geocode: async () => [raw],
                autocomplete: async () => [],
                reverseGeocode: async () => null,
              },
            ],
          ],
        ]),
      },
    ],
  } as unknown as IntegrationContext;
  const [captured] = await getGeocodingProvider(ctx).geocode("q");
  selected.name = "Changed catalogue";
  expect(captured.contributors?.map((receipt) => receipt.name)).toEqual(["Captured selected"]);
  expect(raw.provider).toBeUndefined();
  expect(raw.contributors).toBeUndefined();
});

it("captures geocoder metadata before the selected backend request resolves", async () => {
  let finish!: (rows: SearchResult[]) => void;
  const source = {
    sourceId: "selected",
    name: "Original acquired notice",
    url: "https://example.test",
    licensing: licensingFromDeclaration("CC0-1.0", undefined),
  };
  const selected = {
    ...provider([]),
    geocode: () =>
      new Promise<SearchResult[]>((resolve) => {
        finish = resolve;
      }),
  };
  const ctx = {
    config: { provider: "photon" },
    getIntegrationsByDomain: () => [
      {
        id: "geocoding-photon",
        manifest: { dataSources: [source] },
        providers: new Map([["geocoding", [selected]]]),
      },
    ],
  } as unknown as IntegrationContext;
  const pending = getGeocodingProvider(ctx).geocode("q");
  source.name = "Changed catalogue";
  finish([{ ...result("row"), sourceIds: ["selected"] }]);
  expect((await pending)[0].contributors?.[0].name).toBe("Original acquired notice");
});

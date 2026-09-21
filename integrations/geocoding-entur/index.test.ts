import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setup } from "./index.js";
import { setEnturGeocodingConfig } from "./provider.js";

const CALL = { signal: new AbortController().signal, deadlineAt: Number.POSITIVE_INFINITY };

const OSLO_S = {
  geometry: { coordinates: [10.75, 59.911] },
  properties: {
    id: "NSR:StopPlace:337",
    name: "Oslo S",
    label: "Oslo S, Oslo",
    layer: "venue",
    locality: "Oslo",
    country_a: "NOR",
    category: ["railStation"],
    mode: [{ rail: null }],
  },
};

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn().mockResolvedValue(Response.json({ features: [OSLO_S] }));
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  setEnturGeocodingConfig({});
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function activate(config: Record<string, unknown> = {}) {
  const ctx = createMockIntegrationContext({ id: "geocoding-entur", config });
  setup(ctx);
  setEnturGeocodingConfig({
    clientName: "test-client",
    boundaryCountry: (config.boundaryCountry as string | undefined) ?? "NOR",
  });
  return ctx;
}

describe("geocoding-entur search suggestions", () => {
  it("registers both a geocoding provider and a suggestion provider", () => {
    const ctx = activate();
    expect(ctx.registered.geocoding).toHaveLength(1);
    expect(ctx.registered.searchSuggestions.map((p) => p.id)).toEqual(["geocoding-entur"]);
  });

  it("contributes Norwegian stop places with NSR identities and Entur attribution", async () => {
    const ctx = activate();
    const [provider] = ctx.registered.searchSuggestions;

    const result = await provider.searchSuggestions(
      { query: "Oslo", lang: "en", limit: 8, proximity: [10.7, 59.9] },
      CALL,
    );

    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]).toMatchObject({
      id: "nsr:StopPlace:337",
      type: "transit_stop",
      ids: { entur: "NSR:StopPlace:337", nsr: "StopPlace:337" },
      provider: "geocoding-entur",
    });
    expect(result.attributions).toEqual([
      expect.objectContaining({ sourceId: "entur-geocoder", attributionText: expect.any(String) }),
    ]);
  });

  it("skips the upstream entirely for queries anchored outside Norway", async () => {
    const ctx = activate();
    const [provider] = ctx.registered.searchSuggestions;

    const result = await provider.searchSuggestions(
      { query: "Oslo", lang: "en", limit: 8, proximity: [13.4, 52.5] },
      CALL,
    );

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.suggestions).toEqual([]);
  });

  it("drops the coverage gate when the boundary country is cleared", async () => {
    const ctx = activate();
    setEnturGeocodingConfig({ clientName: "test-client", boundaryCountry: "" });
    const [provider] = ctx.registered.searchSuggestions;

    await provider.searchSuggestions(
      { query: "Oslo", lang: "en", limit: 8, proximity: [13.4, 52.5] },
      CALL,
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

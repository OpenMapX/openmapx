import type { AutocompleteResult } from "@openmapx/core";
import { describe, expect, it, vi } from "vitest";
import type { GeocodingProvider } from "../contracts/index.js";
import { createGeocoderSuggestionProvider } from "../geocoder-suggestions";

const CALL = { signal: new AbortController().signal, deadlineAt: Number.POSITIVE_INFINITY };

const OSLO_S: AutocompleteResult = {
  id: "nsr:StopPlace:337",
  label: "Oslo S",
  sublabel: "Oslo",
  coordinates: [10.75, 59.911],
  type: "transit_stop",
  transitStop: {
    id: "nsr:StopPlace:337",
    ids: { entur: "NSR:StopPlace:337", nsr: "StopPlace:337" },
    name: "Oslo S",
    lat: 59.911,
    lng: 10.75,
    modes: ["rail"],
    provider: "entur",
  },
};

const NO_COORDS: AutocompleteResult = { id: "x", label: "Nowhere", type: "region" };

function geocoder(results: AutocompleteResult[] = [OSLO_S]): GeocodingProvider & {
  autocomplete: ReturnType<typeof vi.fn>;
} {
  return {
    geocode: vi.fn().mockResolvedValue([]),
    autocomplete: vi.fn().mockResolvedValue(results),
    reverseGeocode: vi.fn().mockResolvedValue(null),
  };
}

const ATTRIBUTION = { sourceId: "entur-geocoder", name: "Entur" };

describe("createGeocoderSuggestionProvider", () => {
  it("maps autocomplete rows to ranked suggestions with match evidence and ids", async () => {
    const provider = createGeocoderSuggestionProvider({
      id: "geocoding-entur",
      geocoder: geocoder([OSLO_S, NO_COORDS]),
      attributions: () => [ATTRIBUTION],
    });

    const result = await provider.searchSuggestions({ query: "Oslo", lang: "en", limit: 8 }, CALL);

    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]).toMatchObject({
      id: "nsr:StopPlace:337",
      label: "Oslo S",
      coordinates: [10.75, 59.911],
      type: "transit_stop",
      ids: { entur: "NSR:StopPlace:337", nsr: "StopPlace:337" },
      searchMatch: { kind: "name", value: "Oslo S", normalized: "oslo s" },
      importance: 0.7,
      provider: "geocoding-entur",
      contributingProviders: ["geocoding-entur"],
    });
    expect(result.attributions).toEqual([ATTRIBUTION]);
    expect(result.freshnessSeconds).toBe(3_600);
  });

  it("passes query and language to the geocoder and truncates to the limit", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      ...OSLO_S,
      id: `row-${i}`,
    }));
    const upstream = geocoder(rows);
    const provider = createGeocoderSuggestionProvider({
      id: "g",
      geocoder: upstream,
      attributions: () => [ATTRIBUTION],
    });

    const result = await provider.searchSuggestions({ query: "Oslo", lang: "nb", limit: 2 }, CALL);

    expect(upstream.autocomplete).toHaveBeenCalledWith("Oslo", "nb");
    expect(result.suggestions.map((s) => s.id)).toEqual(["row-0", "row-1"]);
  });

  it("returns nothing, without calling upstream, when the proximity lies outside coverage", async () => {
    const upstream = geocoder();
    const provider = createGeocoderSuggestionProvider({
      id: "g",
      geocoder: upstream,
      attributions: () => [ATTRIBUTION],
      coverage: () => [4, 57.5, 32, 72],
    });

    const result = await provider.searchSuggestions(
      { query: "Oslo", lang: "en", limit: 8, proximity: [13.4, 52.5] },
      CALL,
    );

    expect(upstream.autocomplete).not.toHaveBeenCalled();
    expect(result).toEqual({ suggestions: [], attributions: [], freshnessSeconds: 3_600 });
  });

  it("calls upstream when the proximity is inside coverage or absent", async () => {
    const upstream = geocoder();
    const provider = createGeocoderSuggestionProvider({
      id: "g",
      geocoder: upstream,
      attributions: () => [ATTRIBUTION],
      coverage: () => [4, 57.5, 32, 72],
    });

    await provider.searchSuggestions(
      { query: "Oslo", lang: "en", limit: 8, proximity: [10.7, 59.9] },
      CALL,
    );
    await provider.searchSuggestions({ query: "Oslo", lang: "en", limit: 8 }, CALL);

    expect(upstream.autocomplete).toHaveBeenCalledTimes(2);
  });

  it("omits attributions when no suggestion survived", async () => {
    const provider = createGeocoderSuggestionProvider({
      id: "g",
      geocoder: geocoder([]),
      attributions: () => [ATTRIBUTION],
    });

    const result = await provider.searchSuggestions({ query: "zzz", lang: "en", limit: 8 }, CALL);

    expect(result.attributions).toEqual([]);
  });

  it("honours a custom importance and rejects on an aborted signal", async () => {
    const provider = createGeocoderSuggestionProvider({
      id: "g",
      geocoder: geocoder(),
      attributions: () => [ATTRIBUTION],
      importance: () => 0.9,
    });

    const ok = await provider.searchSuggestions({ query: "Oslo", lang: "en", limit: 8 }, CALL);
    expect(ok.suggestions[0]?.importance).toBe(0.9);

    const controller = new AbortController();
    controller.abort();
    await expect(
      provider.searchSuggestions(
        { query: "Oslo", lang: "en", limit: 8 },
        { signal: controller.signal, deadlineAt: 0 },
      ),
    ).rejects.toThrow();
  });
});

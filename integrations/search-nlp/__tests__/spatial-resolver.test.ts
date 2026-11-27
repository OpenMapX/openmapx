import type { GeocodingProvider, IntegrationContext } from "@openmapx/integration-framework";
import { describe, expect, it, vi } from "vitest";
import { resolveSpatialConstraint } from "../spatial-resolver";

const mapBbox = { south: 48.85, west: 2.33, north: 48.87, east: 2.37 };
const mapCenter: [number, number] = [2.3522, 48.8566];

function geocoder(geocode: GeocodingProvider["geocode"]): GeocodingProvider {
  return {
    geocode,
    autocomplete: vi.fn().mockResolvedValue([]),
    reverseGeocode: vi.fn().mockResolvedValue(null),
  };
}

function ctxOf(
  geocoders: Array<[string, GeocodingProvider["geocode"]]>,
  order: readonly string[],
): IntegrationContext {
  const integrations = geocoders.map(([id, geocode]) => ({
    id,
    providers: new Map([["geocoding", [geocoder(geocode)]]]),
  }));
  return {
    getProviderOrder: (domain: string) => (domain === "geocoding" ? order : []),
    getIntegrationsByDomain: () => integrations,
  } as unknown as IntegrationContext;
}

function makeCtx(geocode: GeocodingProvider["geocode"]): IntegrationContext {
  return ctxOf([["geocoding-maptiler", geocode]], ["geocoding-maptiler"]);
}

function emptyCtx(): IntegrationContext {
  return ctxOf([], []);
}

describe("resolveSpatialConstraint", () => {
  it("null constraint → returns mapBbox unchanged", async () => {
    const result = await resolveSpatialConstraint(null, mapBbox, mapCenter, emptyCtx());
    expect(result).toEqual(mapBbox);
  });

  it("current_view → returns mapBbox unchanged", async () => {
    const result = await resolveSpatialConstraint(
      { type: "current_view" },
      mapBbox,
      mapCenter,
      emptyCtx(),
    );
    expect(result).toEqual(mapBbox);
  });

  it("within_bbox → returns the given bbox", async () => {
    const bbox = { south: 51.4, west: -0.2, north: 51.6, east: 0.1 };
    const result = await resolveSpatialConstraint(
      { type: "within_bbox", ...bbox },
      mapBbox,
      mapCenter,
      emptyCtx(),
    );
    expect(result).toEqual(bbox);
  });

  it("near_coordinates → ~2km bbox around the given point", async () => {
    const result = await resolveSpatialConstraint(
      { type: "near_coordinates", lat: 52.52, lng: 13.405 },
      mapBbox,
      mapCenter,
      emptyCtx(),
    );
    expect(result.south).toBeCloseTo(52.5, 3);
    expect(result.north).toBeCloseTo(52.54, 3);
    expect(result.west).toBeCloseTo(13.385, 3);
    expect(result.east).toBeCloseTo(13.425, 3);
  });

  it("near_place with geocode hit → bbox around result, passes correct args", async () => {
    const geocode = vi.fn().mockResolvedValue([{ coordinates: [2.3, 48.9], confidence: 0.9 }]);
    const ctx = makeCtx(geocode);

    const result = await resolveSpatialConstraint(
      { type: "near_place", place_name: "Gare du Nord" },
      mapBbox,
      mapCenter,
      ctx,
      undefined,
    );

    expect(geocode).toHaveBeenCalledWith("Gare du Nord", undefined, mapCenter);
    expect(result.south).toBeCloseTo(48.88, 5);
    expect(result.north).toBeCloseTo(48.92, 5);
    expect(result.west).toBeCloseTo(2.28, 5);
    expect(result.east).toBeCloseTo(2.32, 5);
  });

  it("near_place with a lang param passes lang to geocode", async () => {
    const geocode = vi.fn().mockResolvedValue([{ coordinates: [2.3, 48.9], confidence: 0.9 }]);
    const ctx = makeCtx(geocode);

    await resolveSpatialConstraint(
      { type: "near_place", place_name: "Gare du Nord" },
      mapBbox,
      mapCenter,
      ctx,
      "fr",
    );

    expect(geocode).toHaveBeenCalledWith("Gare du Nord", "fr", mapCenter);
  });

  it("near_place with empty geocode result → returns mapBbox", async () => {
    const geocode = vi.fn().mockResolvedValue([]);
    const ctx = makeCtx(geocode);

    const result = await resolveSpatialConstraint(
      { type: "near_place", place_name: "Nowhere" },
      mapBbox,
      mapCenter,
      ctx,
    );

    expect(result).toEqual(mapBbox);
  });

  it("near_place asks the first geocoder in the operator's selection", async () => {
    const unlisted = vi.fn().mockResolvedValue([{ coordinates: [9, 9], confidence: 1 }]);
    const second = vi.fn().mockResolvedValue([{ coordinates: [8, 8], confidence: 1 }]);
    const first = vi.fn().mockResolvedValue([{ coordinates: [2.3, 48.9], confidence: 1 }]);
    const ctx = ctxOf(
      [
        ["geocoding-nominatim", unlisted],
        ["geocoding-photon", second],
        ["community-geocoder", first],
      ],
      ["community-geocoder", "geocoding-photon"],
    );

    const result = await resolveSpatialConstraint(
      { type: "near_place", place_name: "Gare du Nord" },
      mapBbox,
      mapCenter,
      ctx,
    );

    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
    expect(unlisted).not.toHaveBeenCalled();
    expect(result.west).toBeCloseTo(2.28, 5);
  });

  it("near_place with only unselected geocoders → returns mapBbox", async () => {
    const unlisted = vi.fn().mockResolvedValue([{ coordinates: [9, 9], confidence: 1 }]);
    const ctx = ctxOf([["geocoding-nominatim", unlisted]], ["geocoding-maptiler"]);
    const result = await resolveSpatialConstraint(
      { type: "near_place", place_name: "Somewhere" },
      mapBbox,
      mapCenter,
      ctx,
    );
    expect(unlisted).not.toHaveBeenCalled();
    expect(result).toEqual(mapBbox);
  });

  it("near_place with no geocoding provider → returns mapBbox", async () => {
    const result = await resolveSpatialConstraint(
      { type: "near_place", place_name: "Somewhere" },
      mapBbox,
      mapCenter,
      emptyCtx(),
    );
    expect(result).toEqual(mapBbox);
  });
});

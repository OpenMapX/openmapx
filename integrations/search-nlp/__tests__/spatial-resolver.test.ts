import type { GeocodingProvider, IntegrationContext } from "@openmapx/integration-framework";
import { describe, expect, it, vi } from "vitest";
import { resolveSpatialConstraint } from "../spatial-resolver";

const mapBbox = { south: 48.85, west: 2.33, north: 48.87, east: 2.37 };
const mapCenter: [number, number] = [2.3522, 48.8566];

function makeCtx(geocode: GeocodingProvider["geocode"]): IntegrationContext {
  const provider: GeocodingProvider = {
    geocode,
    autocomplete: vi.fn().mockResolvedValue([]),
    reverseGeocode: vi.fn().mockResolvedValue(null),
  };
  return {
    getIntegrationsByDomain: () => [{ providers: new Map([["geocoding", [provider]]]) }],
  } as unknown as IntegrationContext;
}

function emptyCtx(): IntegrationContext {
  return {
    getIntegrationsByDomain: () => [],
  } as unknown as IntegrationContext;
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

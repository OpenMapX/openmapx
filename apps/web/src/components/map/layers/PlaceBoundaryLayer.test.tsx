import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeMap, expectStyleSwapIsLossless } from "@/test";

let fake = createFakeMap({
  styleLoaded: true,
  baseLayers: [{ id: "place-labels", type: "symbol" }],
});

const receipt = { sourceId: "acquired-boundary", name: "Acquired boundary supplier" };
let hasBoundary = true;
const selectedPlace = {
  id: "area:1",
  name: "Neuss",
  category: "region",
  coordinates: [6.6879, 51.198] as [number, number],
  primaryScheme: "osm",
  address: "Neuss",
};

const boundary = {
  type: "Polygon" as const,
  coordinates: [
    [
      [6.6, 51.1],
      [6.8, 51.1],
      [6.8, 51.3],
      [6.6, 51.3],
      [6.6, 51.1],
    ],
  ],
};

vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({
    mapRef: { current: fake.map },
    mapReady: true,
    styleVersion: 0,
    fitBounds: vi.fn(),
    flyTo: vi.fn(),
  }),
}));
vi.mock("@openmapx/core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  usePlaceStore: (selector: (s: { selectedPlace: typeof selectedPlace }) => unknown) =>
    selector({ selectedPlace }),
  usePlaceDetails: () => ({
    data: {
      boundary: hasBoundary ? boundary : undefined,
      boundingBox: [6.6, 51.1, 6.8, 51.3],
      fieldContributors: {
        boundary: [receipt],
        name: [{ sourceId: "other", name: "Name supplier" }],
      },
    },
  }),
}));

import type { MapGeoJSONFeature } from "maplibre-gl";
import { useMapAttributionStore } from "@/integration-api/overlay/mapAttributionStore";
import { PlaceBoundaryLayer } from "./PlaceBoundaryLayer";

describe("PlaceBoundaryLayer across a style change", () => {
  it("keeps the boundary outline", () => {
    render(<PlaceBoundaryLayer />);
    const before = fake.state.sources.get("place-boundary-source")?.data as { features: unknown[] };
    expect(before.features.length).toBeGreaterThan(0);
    expectStyleSwapIsLossless(fake);
  });
});

beforeEach(() => {
  fake = createFakeMap({ styleLoaded: true, baseLayers: [{ id: "place-labels", type: "symbol" }] });
  hasBoundary = true;
  useMapAttributionStore.setState({ byLayer: {} });
});
afterEach(() => vi.useRealTimers());
it("owns captured boundary receipts only while fill or outline is actually rendered", () => {
  vi.useFakeTimers();
  const view = render(<PlaceBoundaryLayer />);
  const data = fake.state.sources.get("place-boundary-source")?.data as GeoJSON.FeatureCollection;
  expect(JSON.parse(data.features[0].properties?._mapAttributions)).toEqual([receipt]);
  const html = () =>
    Object.values(useMapAttributionStore.getState().byLayer)
      .flat()
      .map((e) => e.fullHtml)
      .join(" ");
  const flush = () =>
    act(() => {
      fake.emit("render");
      vi.advanceTimersByTime(250);
    });
  fake.setRenderedFeatures("place-boundary-line", data.features as MapGeoJSONFeature[]);
  flush();
  expect(html()).toContain("Acquired boundary supplier");
  expect(html()).not.toContain("Name supplier");
  fake.setRenderedFeatures("place-boundary-line", []);
  fake.setRenderedFeatures("place-boundary-fill", data.features as MapGeoJSONFeature[]);
  flush();
  expect(html()).toContain("Acquired boundary supplier");
  fake.setRenderedFeatures("place-boundary-fill", []);
  flush();
  expect(html()).toBe("");
  hasBoundary = false;
  view.rerender(<PlaceBoundaryLayer />);
  expect(
    (fake.state.sources.get("place-boundary-source")?.data as GeoJSON.FeatureCollection).features,
  ).toEqual([]);
  view.unmount();
  expect(useMapAttributionStore.getState().byLayer).toEqual({});
  expect(fake.state.handlers.get("render")?.size ?? 0).toBe(0);
});

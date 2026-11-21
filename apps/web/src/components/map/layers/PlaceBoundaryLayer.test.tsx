import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createFakeMap, nth } from "@/test";

let fake = createFakeMap({
  styleLoaded: true,
  baseLayers: [{ id: "place-labels", type: "symbol" }],
});

const receipt = { sourceId: "acquired-boundary", name: "Acquired boundary supplier" };
let hasBoundary = true;
const fitBounds = vi.fn();
let boundingBox: number[] | undefined = [6.6, 51.1, 6.8, 51.3];
const selectedPlace = {
  id: "area:1",
  name: "Neuss",
  category: "region",
  coordinates: [6.6879, 51.198] as [number, number],
  primaryScheme: "osm",
  address: "Neuss",
};

let boundary: { type: "Polygon"; coordinates: number[][][] };
const squareBoundary = {
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
    fitBounds,
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
      boundingBox,
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

beforeEach(() => {
  fake = createFakeMap({ styleLoaded: true, baseLayers: [{ id: "place-labels", type: "symbol" }] });
  hasBoundary = true;
  boundary = squareBoundary;
  boundingBox = [6.6, 51.1, 6.8, 51.3];
  fitBounds.mockReset();
  useMapAttributionStore.setState({ byLayer: {} });
});
afterEach(() => vi.useRealTimers());

it("fits the boundary's own extent when the place carries no bounding box", () => {
  boundingBox = undefined;
  render(<PlaceBoundaryLayer />).unmount();
  expect(fitBounds).toHaveBeenCalledExactlyOnceWith(
    [
      [6.6, 51.1],
      [6.8, 51.3],
    ],
    60,
  );
});

it("leaves the camera alone for a boundary without a single position", () => {
  boundingBox = undefined;
  boundary = { type: "Polygon", coordinates: [[]] };
  render(<PlaceBoundaryLayer />).unmount();
  expect(fitBounds).not.toHaveBeenCalled();
});
it("owns captured boundary receipts only while fill or outline is actually rendered", () => {
  vi.useFakeTimers();
  const view = render(<PlaceBoundaryLayer />);
  const data = fake.state.sources.get("place-boundary-source")?.data as GeoJSON.FeatureCollection;
  expect(JSON.parse(nth(data.features, 0).properties?._mapAttributions)).toEqual([receipt]);
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

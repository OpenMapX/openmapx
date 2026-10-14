import type { MapGeoJSONFeature } from "maplibre-gl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMapAttributionStore } from "@/integration-api/overlay/mapAttributionStore";
import { act, createFakeMap, type FakeMap, render } from "@/test";
import { captureIsochroneContributors } from "../../../packages/core/src/hooks/transit/travelTimeContributors";
import { useTravelTimeStore } from "../store";

let fake: FakeMap;
let polygonData: unknown;
let surfaceData: unknown;
let streetData: unknown;
const mapRef = {
  get current() {
    return fake.map;
  },
};
vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ mapRef, mapReady: true, styleVersion: 0 }),
}));
vi.mock("@openmapx/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openmapx/core")>()),
  useIsochrone: () => ({ data: streetData }),
  useTransitIsochrone: () => ({
    data: polygonData,
    attributions: [{ sourceId: "polygons", name: "Polygon supplier" }],
  }),
  useTransitReachability: () => ({
    data: surfaceData,
    attributions: surfaceData ? [{ sourceId: "surface", name: "Surface supplier" }] : [],
  }),
}));

import { TravelTimeLayer } from "../map-layer";

const old = {
  sourceId: "polygons",
  name: "Polygon supplier",
  attributionText: "Original required notice",
};
function capturedPolygon(receipt = old) {
  return captureIsochroneContributors({
    data: {
      featureCollection: {
        type: "FeatureCollection" as const,
        features: [
          {
            type: "Feature" as const,
            geometry: {
              type: "Polygon" as const,
              coordinates: [
                [
                  [0, 0],
                  [1, 0],
                  [1, 1],
                  [0, 0],
                ],
              ],
            },
            properties: { color: "#6F42C1", opacity: 0.2 },
          },
        ],
      },
    },
    attributions: [receipt],
  }).data;
}
function placePolygons() {
  const data = fake.state.sources.get("travel-time-source")?.data as GeoJSON.FeatureCollection;
  fake.setRenderedFeatures("travel-time-fill", data.features as MapGeoJSONFeature[]);
}
function flush() {
  act(() => {
    fake.emit("render");
    vi.advanceTimersByTime(250);
  });
}
function html() {
  return Object.values(useMapAttributionStore.getState().byLayer)
    .flat()
    .map((entry) => entry.fullHtml)
    .join(" ");
}
beforeEach(() => {
  vi.useFakeTimers();
  fake = createFakeMap();
  polygonData = capturedPolygon();
  surfaceData = undefined;
  streetData = undefined;
  useMapAttributionStore.setState({ byLayer: {} });
  useTravelTimeStore.setState({
    isActive: true,
    mode: "transit",
    anchored: true,
    origin: [0, 0],
    queryTime: "2026-10-13T08:00:00Z",
    transitSurfaceKind: "polygons",
    transitPolygonBbox: [0, 0, 1, 1],
    selectedMinutes: [15],
    showTransitStops: false,
  });
});
afterEach(() => {
  act(() => useTravelTimeStore.setState({ isActive: false }));
  vi.useRealTimers();
});
describe("TravelTimeLayer actual rendered response ownership", () => {
  it("credits successful sampled polygons when independent reachability fails", () => {
    render(<TravelTimeLayer />);
    placePolygons();
    flush();
    expect(html()).toContain("Original required notice");
    expect(html()).not.toContain("Surface supplier");
  });
  it("removes polygon credit when estimated mode hides those features", () => {
    render(<TravelTimeLayer />);
    placePolygons();
    flush();
    expect(html()).toContain("Original required notice");
    act(() => useTravelTimeStore.getState().setTransitSurfaceKind("estimated"));
    flush();
    expect(html()).toBe("");
  });
  it("keeps the original cached rendered polygon receipt while replacement placement is pending", () => {
    const { rerender } = render(<TravelTimeLayer />);
    placePolygons();
    flush();
    polygonData = capturedPolygon({
      sourceId: "new",
      name: "New registry supplier",
      attributionText: "New required notice",
    });
    rerender(<TravelTimeLayer />);
    flush();
    expect(html()).toContain("Original required notice");
    expect(html()).not.toContain("New registry supplier");
    placePolygons();
    flush();
    expect(html()).toContain("New required notice");
    expect(html()).not.toContain("Original required notice");
    fake.setRenderedFeatures("travel-time-fill", []);
    flush();
    expect(html()).toBe("");
  });
});

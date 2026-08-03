import { fetchRoadConditions } from "@openmapx/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeMap, type FakeMap, render, waitFor } from "@/test";

let fake: FakeMap;

const events = [
  {
    id: "oc:1",
    source: "autobahn",
    provider: "road-conditions-openconditions",
    type: "road_closure",
    severity: "critical",
    headline: "Vollsperrung",
    geometry: {
      type: "LineString",
      coordinates: [
        [8, 50.004],
        [8, 50.006],
      ],
    },
  },
];

// A stable ref object (not a fresh `{ current: ... }` literal per call),
// matching the real `MapContext`'s contract — its `mapRef` comes from a single
// `useRef` in `MapProvider`, so the ref object itself never changes identity,
// only `.current` does. The fetch effect below lists `mapRef` in its own
// dependency array (needed to read `map.getZoom()`/attach a listener), so an
// unstable mock here would re-run that effect — and re-fire the fetch it
// guards — on every render.
const MAP_REF = {
  get current() {
    return fake.map;
  },
};
vi.mock("@/lib/MapContext", () => ({
  useMap: () => ({ mapRef: MAP_REF, mapReady: true, styleVersion: 0 }),
}));
// A value distinct from any plausible hardcoded zoom threshold (e.g. 10), so a
// passing `maxzoom` assertion actually proves the layer reads this hook rather
// than a literal that happens to coincide with it.
vi.mock("@/lib/overlayZoomGate", () => ({ useOverlayMinZoom: () => 7 }));
vi.mock("@/components/map/overlay/useOverlayStoreState", () => ({
  useOverlayLayerVisible: () => true,
}));
// A stable object/array reference across calls, matching the real hook's
// contract (backed by TanStack Query's cache, which keeps `data` referentially
// stable until a genuine refetch lands). A fresh literal returned on every
// call would make `geometry` recompute on every render, re-running the fetch
// effect that many times too — which raced two different mocked responses in
// an earlier version of this suite.
const DRAWN_STATE = {
  routes: [
    {
      geometry: [
        [8, 50],
        [8, 50.01],
      ],
      distance: 1100,
      duration: 60,
    },
  ],
  activeRouteIndex: 0,
  mode: "driving",
  isEvMode: false,
  evStops: [],
  navigating: false,
};
vi.mock("@/lib/useDrawnDirectionsRoutes", () => ({
  useDrawnDirectionsRoutes: () => DRAWN_STATE,
}));
vi.mock("@openmapx/core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchRoadConditions: vi.fn(async () => events),
}));

import { RouteConditionsLayer } from "../route-layer";

const fetchMock = vi.mocked(fetchRoadConditions);

beforeEach(() => {
  // Below the mocked minZoom (7) by default, so tests that don't care about
  // the zoom gate still see a fetch happen.
  fake = createFakeMap({ styleLoaded: true, zoom: 5 });
  fetchMock.mockClear();
  fetchMock.mockResolvedValue(events);
});

describe("RouteConditionsLayer", () => {
  it("reads maxzoom from the overlay's min-zoom hook, not a hardcoded value", async () => {
    render(<RouteConditionsLayer />);
    await waitFor(() =>
      expect(fake.state.layers.has("omx-road-conditions-route-markers")).toBe(true),
    );
    expect(fake.state.layers.get("omx-road-conditions-route-markers")?.maxzoom).toBe(7);
    expect(fake.state.layers.get("omx-road-conditions-route-line")?.maxzoom).toBe(7);
  });

  it("keeps only the conditions that project onto the route", async () => {
    render(<RouteConditionsLayer />);
    await waitFor(() => {
      const data = fake.state.sources.get("omx-road-conditions-route-markers")
        ?.data as GeoJSON.FeatureCollection;
      expect(data.features).toHaveLength(1);
    });
  });

  it("collapses explicitly grouped route line records into one marker and one line", async () => {
    fetchMock.mockResolvedValueOnce([
      {
        id: "oc:route-1",
        source: "autobahn",
        provider: "road-conditions-openconditions",
        groupId: "works-42",
        type: "roadworks",
        severity: "medium",
        headline: "Roadworks",
        geometry: {
          type: "LineString",
          coordinates: [
            [8, 50.001],
            [8, 50.004],
          ],
        },
      },
      {
        id: "oc:route-2",
        source: "autobahn",
        provider: "road-conditions-openconditions",
        groupId: "works-42",
        type: "lane_closure",
        severity: "high",
        headline: "Lane closure",
        geometry: {
          type: "LineString",
          coordinates: [
            [8, 50.004],
            [8, 50.007],
          ],
        },
      },
    ]);

    render(<RouteConditionsLayer />);
    await waitFor(() => {
      const markers = fake.state.sources.get("omx-road-conditions-route-markers")
        ?.data as GeoJSON.FeatureCollection;
      const lines = fake.state.sources.get("omx-road-conditions-route-lines")
        ?.data as GeoJSON.FeatureCollection;
      expect(markers.features).toHaveLength(1);
      expect(lines.features).toHaveLength(1);
    });

    const markers = fake.state.sources.get("omx-road-conditions-route-markers")
      ?.data as GeoJSON.FeatureCollection;
    expect(markers.features[0]?.properties?._displayId).toBe(
      "group:road-conditions-openconditions:autobahn:works-42",
    );
  });

  it("keeps unrelated route alerts distinct even when their geometry and date match", async () => {
    fetchMock.mockResolvedValueOnce([
      {
        id: "oc:point-1",
        source: "autobahn",
        provider: "road-conditions-openconditions",
        groupId: "works-a",
        type: "roadworks",
        severity: "medium",
        headline: "Roadworks",
        geometry: { type: "Point", coordinates: [8, 50.004] },
        validFrom: "2026-08-03T00:00:00Z",
      },
      {
        id: "oc:point-2",
        source: "autobahn",
        provider: "road-conditions-openconditions",
        groupId: "works-b",
        type: "roadworks",
        severity: "medium",
        headline: "Roadworks",
        geometry: { type: "Point", coordinates: [8, 50.004] },
        validFrom: "2026-08-03T00:00:00Z",
      },
    ]);

    render(<RouteConditionsLayer />);
    await waitFor(() => {
      const data = fake.state.sources.get("omx-road-conditions-route-markers")
        ?.data as GeoJSON.FeatureCollection;
      expect(data.features).toHaveLength(2);
    });
  });

  it("places one marker per MultiPoint endpoint rather than their centroid", async () => {
    // A DATEX-style "zwischen X und Y" closure: only the two endpoints are
    // known, with no path between them. The centroid `representativePoint`
    // would return for this geometry can land off the road; the layer must
    // place a marker at each real endpoint instead (matching the area
    // overlay's own placement in map-layer.tsx).
    fetchMock.mockResolvedValueOnce([
      {
        id: "oc:2",
        source: "autobahn",
        provider: "road-conditions-openconditions",
        type: "road_closure",
        severity: "critical",
        headline: "Vollsperrung",
        geometry: {
          type: "MultiPoint",
          coordinates: [
            [8, 50.002],
            [8, 50.008],
          ],
        },
      },
    ]);
    render(<RouteConditionsLayer />);
    await waitFor(() => {
      const data = fake.state.sources.get("omx-road-conditions-route-markers")
        ?.data as GeoJSON.FeatureCollection;
      expect(data.features).toHaveLength(2);
    });
    const data = fake.state.sources.get("omx-road-conditions-route-markers")
      ?.data as GeoJSON.FeatureCollection;
    const coords = data.features.map((f) => (f.geometry as GeoJSON.Point).coordinates);
    expect(coords).toEqual(
      expect.arrayContaining([
        [8, 50.002],
        [8, 50.008],
      ]),
    );
  });

  it("does not fetch while the map is at or above the overlay's min zoom", async () => {
    fake = createFakeMap({ styleLoaded: true, zoom: 9 });
    render(<RouteConditionsLayer />);
    // Let any stray microtask run before asserting the negative.
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches immediately on crossing back below min zoom, and pauses again above it", async () => {
    fake = createFakeMap({ styleLoaded: true, zoom: 9 });
    render(<RouteConditionsLayer />);
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();

    fake.state.zoom = 5;
    fake.emit("zoomend");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    fetchMock.mockClear();
    fake.state.zoom = 9;
    fake.emit("zoomend");
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

import { fetchRoadConditions } from "@openmapx/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { INTERACTIVE_LAYER_IDS } from "@/lib/interactiveLayers";
import { createFakeMap, type FakeMap, render, waitFor } from "@/test";
import { useRoadConditionsStore } from "../store";

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
vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());
vi.mock("@/lib/useDateTimeFormat", () => ({
  useDateTimeFormat: () => ({
    dateTime: (value: string | number | Date) => String(value),
    date: (value: string | number | Date) => String(value),
  }),
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
vi.mock("@openmapx/core", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  const fetchRoadConditions = vi.fn(async () => events);
  return {
    ...original,
    fetchRoadConditions,
    fetchRoadConditionsWithStatus: vi.fn(async (bbox: unknown) => ({
      ok: true,
      events: await fetchRoadConditions(bbox as never),
    })),
  };
});

const popupState = vi.hoisted(() => ({ html: "" }));
vi.mock("maplibre-gl", () => ({
  Popup: class FakePopup {
    setLngLat() {
      return this;
    }
    setHTML(html: string) {
      popupState.html = html;
      return this;
    }
    addTo() {
      return this;
    }
    remove() {
      return this;
    }
  },
}));

import { RouteConditionsLayer } from "../route-layer";

const fetchMock = vi.mocked(fetchRoadConditions);
const SOURCE = "omx-road-conditions-route";

function sourceFeatures(geometryType: GeoJSON.Geometry["type"]): GeoJSON.Feature[] {
  const data = fake.state.sources.get(SOURCE)?.data as GeoJSON.FeatureCollection | undefined;
  return (
    data?.features.filter((feature) => {
      if (geometryType === "LineString") {
        return (
          feature.geometry.type === "LineString" || feature.geometry.type === "MultiLineString"
        );
      }
      return feature.geometry.type === geometryType;
    }) ?? []
  );
}

beforeEach(() => {
  // Below the mocked minZoom (7) by default, so tests that don't care about
  // the zoom gate still see a fetch happen.
  fake = createFakeMap({ styleLoaded: true, zoom: 5 });
  fetchMock.mockClear();
  fetchMock.mockResolvedValue(events);
  useRoadConditionsStore.setState({ routeFetchStatus: "idle" });
  popupState.html = "";
  INTERACTIVE_LAYER_IDS.delete("omx-road-conditions-route-markers");
  INTERACTIVE_LAYER_IDS.delete("omx-road-conditions-route-line");
});

describe("RouteConditionsLayer", () => {
  it("replays route data received before the map sources become ready", async () => {
    fake = createFakeMap({ styleLoaded: false, zoom: 5 });

    render(<RouteConditionsLayer />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fake.state.sources.has(SOURCE)).toBe(false);

    fake.state.styleLoaded = true;
    fake.emit("idle");

    await waitFor(() => {
      expect(sourceFeatures("Point")).toHaveLength(1);
      expect(sourceFeatures("LineString")).toHaveLength(1);
    });
  });

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
      expect(sourceFeatures("Point")).toHaveLength(1);
    });
  });

  it("uses the shared upcoming style for route markers and lines", async () => {
    fetchMock.mockResolvedValueOnce([
      {
        id: "oc:future-route",
        source: "autobahn",
        provider: "road-conditions-openconditions",
        type: "roadworks",
        severity: "medium",
        headline: "Roadworks",
        isForecast: true,
        validFrom: "2099-08-03T00:00:00Z",
        geometry: {
          type: "LineString",
          coordinates: [
            [8, 50.001],
            [8, 50.004],
          ],
        },
      },
    ]);

    render(<RouteConditionsLayer />);
    await waitFor(() => {
      expect(sourceFeatures("LineString")).toHaveLength(1);
    });

    const lineFeature = sourceFeatures("LineString")[0];
    const markerFeature = sourceFeatures("Point")[0];
    const linePaint = fake.state.layers.get("omx-road-conditions-route-line")?.paint as Record<
      string,
      unknown
    >;
    const markerPaint = fake.state.layers.get("omx-road-conditions-route-markers")?.paint as Record<
      string,
      unknown
    >;

    expect(lineFeature?.properties?.future).toBe(true);
    expect(markerFeature?.properties?.future).toBe(true);
    expect(linePaint["line-opacity"]).toEqual(["case", ["get", "future"], 0.45, 0.7]);
    expect(linePaint["line-dasharray"]).toEqual([
      "case",
      ["get", "future"],
      ["literal", [2, 1.5]],
      ["literal", [1]],
    ]);
    expect(markerPaint["icon-opacity"]).toEqual(["case", ["get", "future"], 0.55, 1]);
    expect(fake.state.layers.get("omx-road-conditions-route-markers")?.source).toBe(SOURCE);
    expect(fake.state.layers.get("omx-road-conditions-route-line")?.source).toBe(SOURCE);
    expect(fake.state.layers.get("omx-road-conditions-route-line")?.filter).toEqual([
      "match",
      ["geometry-type"],
      ["LineString", "MultiLineString"],
      true,
      false,
    ]);
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
      expect(sourceFeatures("Point")).toHaveLength(1);
      expect(sourceFeatures("LineString")).toHaveLength(1);
    });

    expect(sourceFeatures("Point")[0]?.properties?._displayId).toBe(
      "group:road-conditions-openconditions:autobahn:works-42",
    );
  });

  it("renders exact overlapping route groups once while retaining both display ids", async () => {
    const geometry = {
      type: "LineString" as const,
      coordinates: [
        [8, 50.001],
        [8, 50.004],
      ],
    };
    fetchMock.mockResolvedValueOnce([
      {
        id: "oc:route-congestion",
        source: "autobahn",
        provider: "road-conditions-openconditions",
        groupId: "congestion-group",
        type: "congestion",
        severity: "medium",
        headline: "Traffic congestion",
        geometry,
      },
      {
        id: "oc:route-roadworks",
        source: "autobahn",
        provider: "road-conditions-openconditions",
        groupId: "roadworks-group",
        type: "roadworks",
        severity: "low",
        headline: "Road works",
        geometry,
      },
    ]);

    render(<RouteConditionsLayer />);
    await waitFor(() => expect(sourceFeatures("LineString")).toHaveLength(1));

    expect(sourceFeatures("LineString")[0]?.properties?._displayIds).toEqual([
      "group:road-conditions-openconditions:autobahn:congestion-group",
      "group:road-conditions-openconditions:autobahn:roadworks-group",
    ]);
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
      expect(sourceFeatures("Point")).toHaveLength(2);
    });
  });

  it("registers route markers and lines as one popup target", async () => {
    render(<RouteConditionsLayer />);
    await waitFor(() => {
      expect(fake.state.layers.has("omx-road-conditions-route-line")).toBe(true);
      expect(sourceFeatures("Point")).toHaveLength(1);
      expect(INTERACTIVE_LAYER_IDS.has("omx-road-conditions-route-markers")).toBe(true);
      expect(INTERACTIVE_LAYER_IDS.has("omx-road-conditions-route-line")).toBe(true);
    });

    (
      fake.map as unknown as {
        queryRenderedFeatures: (point: unknown, options?: { layers?: string[] }) => unknown[];
      }
    ).queryRenderedFeatures = (_point, options) =>
      options?.layers?.includes("omx-road-conditions-route-line")
        ? [
            {
              type: "Feature",
              geometry: {
                type: "LineString",
                coordinates: [
                  [8, 50.004],
                  [8, 50.006],
                ],
              },
              properties: { _displayId: "event:oc:1", _sev: 4 },
              layer: { id: "omx-road-conditions-route-line", type: "line" },
            },
          ]
        : [];

    fake.emit("click", {
      point: { x: 10, y: 10 },
      lngLat: { lng: 8, lat: 50.005 },
    });
    expect(popupState.html).toContain("Vollsperrung");
  });

  it("retains route events and reports stale when a refresh fails", async () => {
    render(<RouteConditionsLayer />);
    await waitFor(() => {
      expect(sourceFeatures("Point")).toHaveLength(1);
    });

    fetchMock.mockRejectedValueOnce(new Error("temporary outage"));
    fake.state.zoom = 9;
    fake.emit("zoomend");
    fake.state.zoom = 5;
    fake.emit("zoomend");
    await waitFor(() => expect(useRoadConditionsStore.getState().routeFetchStatus).toBe("stale"));

    expect(sourceFeatures("Point")).toHaveLength(1);
  });

  it("coalesces a refresh while the route request is still in flight", async () => {
    let resolve: ((value: typeof events) => void) | undefined;
    const pending = new Promise<typeof events>((done) => {
      resolve = done;
    });
    fetchMock.mockImplementationOnce(() => pending);
    render(<RouteConditionsLayer />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    fake.state.zoom = 9;
    fake.emit("zoomend");
    fake.state.zoom = 5;
    fake.emit("zoomend");
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolve?.(events);
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
      expect(sourceFeatures("Point")).toHaveLength(2);
    });
    const coords = sourceFeatures("Point").map(
      (feature) => (feature.geometry as GeoJSON.Point).coordinates,
    );
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

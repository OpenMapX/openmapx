import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createFakeMap, type FakeMap, render, waitFor } from "@/test";
import { useRoadConditionsStore } from "../store";

let fake: FakeMap;
// Mutable so the style-change test can bump it and re-render, the same way a
// real style swap would change what `useMap()` returns.
let mockStyleVersion = 0;

vi.mock("@/lib/MapContext", () => ({
  useMap: () => ({ mapRef: { current: fake.map }, mapReady: true, styleVersion: mockStyleVersion }),
}));

vi.mock("@/lib/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: "https://api.test" }),
}));

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

// RoadConditionsLayer now mounts RouteConditionsLayer as a child. That layer
// calls useDrawnDirectionsRoutes, which reaches into TanStack Query hooks this
// suite has no QueryClientProvider for — mock it out with an empty route so it
// stays inert here; its own behavior is covered by route-layer.test.tsx.
vi.mock("@/lib/useDrawnDirectionsRoutes", () => ({
  useDrawnDirectionsRoutes: () => ({
    routes: [],
    activeRouteIndex: 0,
    mode: "driving",
    isEvMode: false,
    evStops: [],
    navigating: false,
  }),
}));

vi.mock("maplibre-gl", () => ({
  Popup: class FakePopup {
    setLngLat() {
      return this;
    }
    setHTML() {
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

import { buildRoadConditionPopupGroups, buildSources, RoadConditionsLayer } from "../map-layer";

const SOURCE = "omx-road-conditions";
const MARKER_LAYER = "omx-road-conditions-markers";
const LINE_LAYER = "omx-road-conditions-line";

const fetchMock = vi.fn();

function inDays(d: number): string {
  return new Date(Date.now() + d * 86_400_000).toISOString();
}

function respondWith(features: unknown[]) {
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ type: "FeatureCollection", features }),
  });
}

/** The URL of the most recent /events fetch. */
function lastUrl(): string {
  return String(fetchMock.mock.calls.at(-1)?.[0] ?? "");
}

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
  fake = createFakeMap();
  mockStyleVersion = 0;
  fetchMock.mockReset();
  respondWith([]);
  vi.stubGlobal("fetch", fetchMock);
  useRoadConditionsStore.setState({ panelOpen: true, layerVisible: true });
  useRoadConditionsStore.getState().resetFilters();
});

describe("RoadConditionsLayer marker images", () => {
  it("uses MapLibre's missing-image resolver and removes it on unmount", async () => {
    const { unmount } = render(<RoadConditionsLayer />);

    await waitFor(() => expect(fake.state.missingStyleImageResolver).toEqual(expect.any(Function)));
    expect(fake.state.handlers.get("styleimagemissing")?.size ?? 0).toBe(0);

    await fake.state.missingStyleImageResolver?.("unrelated-style-image");
    expect(fake.state.images.size).toBe(0);

    unmount();
    expect(fake.state.missingStyleImageResolver).toBeNull();
  });
});

describe("RoadConditionsLayer horizon query", () => {
  it("replays a response received before the map sources become ready", async () => {
    fake = createFakeMap({ styleLoaded: false });
    respondWith([
      {
        geometry: {
          type: "LineString",
          coordinates: [
            [13.4, 52.5],
            [13.41, 52.51],
          ],
        },
        properties: { id: "early", type: "roadworks", severity: "low" },
      },
    ]);

    render(<RoadConditionsLayer />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fake.state.sources.has(SOURCE)).toBe(false);

    fake.state.styleLoaded = true;
    fake.emit("idle");

    await waitFor(() => {
      expect(sourceFeatures("Point")[0]?.properties?._id).toBe("early");
      expect(sourceFeatures("LineString")).toHaveLength(1);
    });
  });

  it("requests horizonDays=0 under the default Active horizon", async () => {
    render(<RoadConditionsLayer />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(lastUrl()).toContain("horizonDays=0");
  });

  it("requests horizonDays=7 for the week step and omits the param for all", async () => {
    useRoadConditionsStore.setState({ horizon: "week" });
    render(<RoadConditionsLayer />);
    await waitFor(() => expect(lastUrl()).toContain("horizonDays=7"));

    fetchMock.mockClear();
    useRoadConditionsStore.setState({ horizon: "all" });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(lastUrl()).not.toContain("horizonDays");
  });

  it("does not let an older viewport response overwrite a newer one", async () => {
    let resolveFirst: ((value: unknown) => void) | undefined;
    let resolveSecond: ((value: unknown) => void) | undefined;
    const first = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    const second = new Promise((resolve) => {
      resolveSecond = resolve;
    });
    fetchMock
      .mockReset()
      .mockImplementationOnce(() => first)
      .mockImplementationOnce(() => second);

    render(<RoadConditionsLayer />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    useRoadConditionsStore.setState({ horizon: "week" });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    resolveSecond?.({
      ok: true,
      json: async () => ({
        features: [
          {
            geometry: { type: "Point", coordinates: [13.42, 52.52] },
            properties: { id: "new", type: "roadworks", severity: "low" },
          },
        ],
      }),
    });
    await waitFor(() => {
      expect(sourceFeatures("Point")[0]?.properties?._id).toBe("new");
    });

    resolveFirst?.({
      ok: true,
      json: async () => ({
        features: [
          {
            geometry: { type: "Point", coordinates: [13.4, 52.5] },
            properties: { id: "old", type: "roadworks", severity: "low" },
          },
        ],
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(sourceFeatures("Point")[0]?.properties?._id).toBe("new");
  });

  it("retains the last viewport data and reports stale after a refresh failure", async () => {
    respondWith([
      {
        geometry: { type: "Point", coordinates: [13.4, 52.5] },
        properties: { id: "last-good", type: "roadworks", severity: "low" },
      },
    ]);
    render(<RoadConditionsLayer />);
    await waitFor(() => {
      expect(sourceFeatures("Point")[0]?.properties?._id).toBe("last-good");
    });

    fetchMock.mockRejectedValueOnce(new Error("temporary outage"));
    useRoadConditionsStore.setState({ horizon: "week" });
    await waitFor(() =>
      expect(useRoadConditionsStore.getState().viewportFetchStatus).toBe("stale"),
    );

    expect(sourceFeatures("Point")[0]?.properties?._id).toBe("last-good");
  });
});

describe("RoadConditionsLayer future styling", () => {
  it("stamps a `future` flag from either isForecast or a future validFrom", async () => {
    respondWith([
      {
        geometry: { type: "Point", coordinates: [13.4, 52.5] },
        properties: { id: "flagged", type: "roadworks", severity: "low", isForecast: true },
      },
      {
        geometry: { type: "Point", coordinates: [13.41, 52.51] },
        properties: {
          id: "dated",
          type: "roadworks",
          severity: "low",
          validFrom: inDays(3),
        },
      },
      {
        geometry: { type: "Point", coordinates: [13.42, 52.52] },
        properties: {
          id: "current",
          type: "roadworks",
          severity: "low",
          validFrom: inDays(-3),
        },
      },
    ]);

    render(<RoadConditionsLayer />);
    await waitFor(() => expect(fake.state.sources.get(SOURCE)?.data).toBeDefined());

    const byId = new Map(
      sourceFeatures("Point").map((feature) => [
        feature.properties?._id,
        feature.properties?.future,
      ]),
    );
    expect(byId.get("flagged")).toBe(true);
    expect(byId.get("dated")).toBe(true);
    expect(byId.get("current")).toBe(false);
  });

  it("carries the future flag onto line features too", async () => {
    respondWith([
      {
        geometry: {
          type: "LineString",
          coordinates: [
            [13.4, 52.5],
            [13.41, 52.51],
          ],
        },
        properties: { id: "line", type: "roadworks", severity: "low", validFrom: inDays(3) },
      },
    ]);

    render(<RoadConditionsLayer />);
    await waitFor(() => expect(fake.state.sources.get(SOURCE)?.data).toBeDefined());

    expect(sourceFeatures("LineString")[0]?.properties?.future).toBe(true);
  });

  it("de-emphasises future features in the layer paint expressions", async () => {
    render(<RoadConditionsLayer />);
    await waitFor(() => expect(fake.state.layers.has(MARKER_LAYER)).toBe(true));

    const markerPaint = fake.state.layers.get(MARKER_LAYER)?.paint as Record<string, unknown>;
    expect(markerPaint["icon-opacity"]).toEqual(["case", ["get", "future"], 0.55, 1]);

    const linePaint = fake.state.layers.get(LINE_LAYER)?.paint as Record<string, unknown>;
    expect(linePaint["line-opacity"]).toEqual(["case", ["get", "future"], 0.45, 0.7]);
    expect(linePaint["line-dasharray"]).toEqual([
      "case",
      ["get", "future"],
      ["literal", [2, 1.5]],
      ["literal", [1]],
    ]);
    expect(fake.state.layers.get(MARKER_LAYER)?.source).toBe(SOURCE);
    expect(fake.state.layers.get(LINE_LAYER)?.source).toBe(SOURCE);
    expect(fake.state.layers.get(MARKER_LAYER)?.filter).toEqual(["==", ["geometry-type"], "Point"]);
    expect(fake.state.layers.get(LINE_LAYER)?.filter).toEqual([
      "match",
      ["geometry-type"],
      ["LineString", "MultiLineString"],
      true,
      false,
    ]);
  });
});

describe("road-condition display grouping", () => {
  it("renders one explicit line group while retaining every child for popup lookup", () => {
    const itinerary = Array.from(
      { length: 17 },
      (_, index) => [6.77 + index * 0.0001, 51.2] as [number, number],
    );
    const { data, eventsByDisplayId } = buildSources([
      {
        geometry: {
          type: "LineString",
          coordinates: itinerary.slice(0, 6),
        },
        properties: {
          id: "oc:1",
          source: "duesseldorf",
          provider: "road-conditions-openconditions",
          groupId: "works-42",
          type: "roadworks",
          severity: "medium",
          headline: "Roadworks",
        },
      },
      {
        geometry: {
          type: "LineString",
          coordinates: itinerary.slice(5, 12),
        },
        properties: {
          id: "oc:2",
          source: "duesseldorf",
          provider: "road-conditions-openconditions",
          groupId: "works-42",
          type: "roadworks",
          severity: "high",
          headline: "Lane closure",
        },
      },
      {
        geometry: { type: "LineString", coordinates: itinerary.slice(11) },
        properties: {
          id: "oc:3",
          source: "duesseldorf",
          provider: "road-conditions-openconditions",
          groupId: "works-42",
          type: "roadworks",
          severity: "medium",
          headline: "Roadworks",
        },
      },
    ]);

    const features = (data as GeoJSON.FeatureCollection).features;
    expect(features.filter((feature) => feature.geometry.type === "Point")).toHaveLength(1);
    expect(
      features.filter(
        (feature) =>
          feature.geometry.type === "LineString" || feature.geometry.type === "MultiLineString",
      ),
    ).toHaveLength(1);
    expect(
      eventsByDisplayId
        .get("group:road-conditions-openconditions:duesseldorf:works-42")
        ?.map((event) => event.id),
    ).toEqual(["oc:1", "oc:2", "oc:3"]);
    const [popupGroup] = buildRoadConditionPopupGroups(
      "group:road-conditions-openconditions:duesseldorf:works-42",
      eventsByDisplayId.get("group:road-conditions-openconditions:duesseldorf:works-42") ?? [],
    );
    expect(popupGroup?.sourceRecords.map((entry) => entry.recordId)).toEqual([
      "oc:1",
      "oc:2",
      "oc:3",
    ]);
    expect(popupGroup?.summary).toMatchObject({
      headline: "Lane closure (3 related records)",
      type: "roadworks",
      sourceRecordCount: 3,
    });
  });

  it("renders exact line overlaps once while keeping every display group for clicks", () => {
    const geometry = {
      type: "LineString" as const,
      coordinates: [
        [6.7766986, 51.215633],
        [6.775376, 51.215633],
      ],
    };
    const { data, eventsByDisplayId } = buildSources([
      {
        geometry,
        properties: {
          id: "congestion",
          source: "duesseldorf",
          provider: "road-conditions-openconditions",
          groupId: "congestion-group",
          type: "congestion",
          severity: "medium",
          headline: "Traffic congestion",
        },
      },
      {
        geometry,
        properties: {
          id: "roadworks",
          source: "duesseldorf",
          provider: "road-conditions-openconditions",
          groupId: "roadworks-group",
          type: "roadworks",
          severity: "low",
          headline: "Road works",
        },
      },
    ]);

    const lines = (data as GeoJSON.FeatureCollection).features.filter(
      (feature) =>
        feature.geometry.type === "LineString" || feature.geometry.type === "MultiLineString",
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]?.properties).toMatchObject({
      severity: "medium",
      _displayIds: [
        "group:road-conditions-openconditions:duesseldorf:congestion-group",
        "group:road-conditions-openconditions:duesseldorf:roadworks-group",
      ],
    });
    expect([...eventsByDisplayId.keys()]).toEqual([
      "group:road-conditions-openconditions:duesseldorf:congestion-group",
      "group:road-conditions-openconditions:duesseldorf:roadworks-group",
    ]);
    expect(
      eventsByDisplayId.get("group:road-conditions-openconditions:duesseldorf:roadworks-group"),
    ).toHaveLength(1);
  });

  it("aggregates mixed grouped source records into one summary and keeps every record in details", () => {
    const dateFrom = "2026-06-22T05:00:00.000Z";
    const dateTo = "2026-09-01T15:00:00.000Z";
    const events = [
      ["road-1", "roadworks", "Road works", "2922"],
      ["road-2", "roadworks", "Road works", "1002"],
      ["road-3", "roadworks", "Road works", "2119"],
      ["info-1", "other", "Traffic information", "2922"],
      ["info-2", "other", "Traffic information", "1002"],
      ["info-3", "other", "Traffic information", "2119"],
    ].map(([id, type, headline, road]) => ({
      id,
      source: "duesseldorf",
      provider: "road-conditions-openconditions",
      groupId: "situation-42",
      type,
      severity: "low",
      headline,
      geometry: {
        type: "LineString" as const,
        coordinates: [
          [6.77, 51.2],
          [6.771, 51.2],
        ],
      },
      roads: [{ ref: road, name: road }],
      validFrom: dateFrom,
      validTo: dateTo,
    }));

    const [group] = buildRoadConditionPopupGroups("group:situation-42", events);

    expect(group?.summary).toMatchObject({
      headline: "Road works (6 related records)",
      type: "roadworks, other",
      roads: "2922, 1002, 2119",
      validFrom: dateFrom,
      validTo: dateTo,
      sourceRecordCount: 6,
    });
    expect(group?.sourceRecords).toHaveLength(6);
    expect(group?.sourceRecords.map((entry) => entry.recordId)).toEqual([
      "road-1",
      "road-2",
      "road-3",
      "info-1",
      "info-2",
      "info-3",
    ]);
  });

  it("keeps endpoint-only MultiPoint records as endpoint markers", () => {
    const { data } = buildSources([
      {
        geometry: {
          type: "MultiPoint",
          coordinates: [
            [6.77, 51.2],
            [6.78, 51.2],
          ],
        },
        properties: {
          id: "oc:endpoints",
          source: "duesseldorf",
          provider: "road-conditions-openconditions",
          type: "roadworks",
          severity: "low",
          headline: "Road works",
        },
      },
    ]);

    const features = (data as GeoJSON.FeatureCollection).features;
    expect(features.filter((feature) => feature.geometry.type === "Point")).toHaveLength(2);
    expect(
      features.filter(
        (feature) =>
          feature.geometry.type === "LineString" || feature.geometry.type === "MultiLineString",
      ),
    ).toHaveLength(0);
  });
});

describe("RoadConditionsLayer viewport scheduler", () => {
  // Mirrors VIEWPORT_FRESHNESS_DEADLINE_MS / VIEWPORT_PADDING_FACTOR in
  // ../map-layer.tsx (the server's `/events` cache TTL, and the padding
  // factor documented there). Not imported — those constants are
  // intentionally private to the module under test.
  const FRESHNESS_DEADLINE_MS = 90_000;
  const BASE_BOX = { west: 10, south: 45, east: 11, north: 46 };

  function setBounds(box: { west: number; south: number; east: number; north: number }) {
    Object.defineProperty(fake.map, "getBounds", {
      value: () => ({
        getWest: () => box.west,
        getSouth: () => box.south,
        getEast: () => box.east,
        getNorth: () => box.north,
      }),
      writable: true,
      configurable: true,
    });
  }

  /** Advance the fake clock while letting fetch/json promise chains settle. */
  async function flush(ms = 0) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  beforeEach(() => {
    setBounds(BASE_BOX);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("bounds getBounds() reads and network requests under a 60Hz moveend burst that stays in the padded viewport", async () => {
    const getBoundsSpy = vi.spyOn(fake.map, "getBounds");
    render(<RoadConditionsLayer />);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockClear();
    getBoundsSpy.mockClear();

    await act(async () => {
      for (let i = 0; i < 3600; i++) {
        fake.emit("moveend");
        await vi.advanceTimersByTimeAsync(1000 / 60);
      }
    });

    // 60 moveend events/second for a simulated minute of continuous,
    // in-bounds camera motion (a followed navigation camera). The scheduler
    // throttles evaluations to at most one per 5s, so ~60s of continuous
    // motion is ~12-13 evaluations — each reads getBounds() exactly once,
    // and since the viewport never left the padded last-fetched bbox, none
    // of them fetch. 3600 raw `moveend` events must not translate into
    // anything close to 3600 of any of this.
    expect(getBoundsSpy.mock.calls.length).toBeGreaterThan(0);
    expect(getBoundsSpy.mock.calls.length).toBeLessThanOrEqual(15);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a real pan that leaves the padded bbox refetches promptly", async () => {
    render(<RoadConditionsLayer />);
    await flush();
    fetchMock.mockClear();

    setBounds({ west: 40, south: 45, east: 41, north: 46 }); // far past BASE_BOX's 50% padding
    fake.emit("moveend");
    await flush(); // the leading-edge evaluation runs with ~0 delay

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastUrl()).toContain("bbox=40");
  });

  it("does not refetch for a move that stays inside the padded bbox", async () => {
    render(<RoadConditionsLayer />);
    await flush();
    fetchMock.mockClear();

    setBounds({ west: 10.1, south: 45.1, east: 11.1, north: 46.1 }); // inside the 50% padding
    fake.emit("moveend");
    await flush();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fires a freshness refresh with no movement at all", async () => {
    render(<RoadConditionsLayer />);
    await flush();
    fetchMock.mockClear();

    await flush(FRESHNESS_DEADLINE_MS - 1);
    expect(fetchMock).not.toHaveBeenCalled();
    await flush(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("holds no repeating short timer once motion stops", async () => {
    render(<RoadConditionsLayer />);
    await flush();

    await act(async () => {
      for (let i = 0; i < 60; i++) {
        fake.emit("moveend");
        await vi.advanceTimersByTimeAsync(1000 / 60);
      }
    });
    await flush(6000); // let any evaluation the burst scheduled actually run

    // Only the freshness deadline should still be armed — a repeating 5s
    // evaluation timer must not survive motion stopping.
    expect(vi.getTimerCount()).toBe(1);
  });

  it("the coalesced evaluation uses the viewport at evaluation time, not at moveend time", async () => {
    render(<RoadConditionsLayer />);
    await flush();
    fetchMock.mockClear();

    fake.emit("moveend"); // schedules the evaluation; it has not run yet
    setBounds({ west: 70, south: 45, east: 71, north: 46 }); // the camera keeps moving before it does
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastUrl()).toContain("bbox=70");
  });

  it("refetches immediately on a style change, and the freshness deadline still fires afterward", async () => {
    const { rerender } = render(<RoadConditionsLayer />);
    await flush();
    fetchMock.mockClear();

    mockStyleVersion += 1;
    await act(async () => {
      rerender(<RoadConditionsLayer />);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The style-change fetch must have re-armed the freshness deadline, not
    // left it cleared by the moveend effect's own cleanup running afterward.
    fetchMock.mockClear();
    await flush(FRESHNESS_DEADLINE_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a freshness-triggered refresh failure keeps the last-good data and reports stale", async () => {
    respondWith([
      {
        geometry: { type: "Point", coordinates: [10.5, 45.5] },
        properties: { id: "last-good", type: "roadworks", severity: "low" },
      },
    ]);
    render(<RoadConditionsLayer />);
    await flush();
    expect(sourceFeatures("Point")[0]?.properties?._id).toBe("last-good");

    fetchMock.mockRejectedValueOnce(new Error("temporary outage"));
    await flush(FRESHNESS_DEADLINE_MS);

    expect(useRoadConditionsStore.getState().viewportFetchStatus).toBe("stale");
    expect(sourceFeatures("Point")[0]?.properties?._id).toBe("last-good");
  });
});

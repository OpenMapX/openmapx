import { IntegrationRegistry } from "@openmapx/integration-framework";
import { IntegrationRegistryContext } from "@openmapx/integration-framework/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMapAttributionStore } from "@/integration-api/overlay/mapAttributionStore";
import { act, createFakeMap, type FakeMap, render, waitFor } from "@/test";
import { useRoadConditionsStore } from "../store";

let fake: FakeMap;
// Mutable so the style-change test can bump it and re-render, the same way a
// real style swap would change what `useMap()` returns.
let mockStyleVersion = 0;
const popupHtml = vi.hoisted(() => vi.fn());
const popupRemove = vi.hoisted(() => vi.fn());
const MAP_REF = {
  get current() {
    return fake.map;
  },
};

vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ mapRef: MAP_REF, mapReady: true, styleVersion: mockStyleVersion }),
}));

vi.mock("@/integration-api/runtime/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: "https://api.test" }),
}));

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

// RoadConditionsLayer now mounts RouteConditionsLayer as a child. That layer
// calls useDrawnDirectionsRoutes, which reaches into TanStack Query hooks this
// suite has no QueryClientProvider for — mock it out with an empty route so it
// stays inert here; its own behavior is covered by route-layer.test.tsx.
vi.mock("@/integration-api/map/useDrawnDirectionsRoutes", () => ({
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
    setHTML(html: string) {
      popupHtml(html);
      return this;
    }
    addTo() {
      return this;
    }
    remove() {
      popupRemove();
      return this;
    }
  },
}));

import type { RoadConditionEvent } from "@openmapx/core";
import { eventsToFeatureCollection } from "../eventsToGeojson";
import { buildSources, RoadConditionsLayer } from "../map-layer";
import { buildIncidentCard, type RoadConditionPopupInput } from "../popup";
import { effect, situation, text } from "./fixtures";

const SOURCE = "omx-road-conditions";
const MARKER_LAYER = "omx-road-conditions-markers";
const LINE_LAYER = "omx-road-conditions-line";

const creditRegistry = new IntegrationRegistry([
  {
    id: "openconditions",
    enabled: true,
    domains: ["road-conditions"],
    dataSources: ["working", "offscreen", "missing-key"].map((sourceId) => ({
      sourceId,
      name: sourceId,
      url: `https://${sourceId}.example`,
      licensing: {
        version: 1,
        bindings: [
          { scope: "data", subject: "Data", license: { kind: "spdx", expression: "CC0-1.0" } },
        ],
      } as const,
      providerCountry: "DE",
      providerPrivacyUrl: "https://example.com/privacy",
    })),
  },
]);

const fetchMock = vi.fn();

const cardInput: RoadConditionPopupInput = {
  hits: [],
  fallbackCoordinates: [0, 0],
  eventsByDisplayId: new Map(),
  formatDateTime: String,
  formatDate: String,
  translate: (key) => key,
  locale: "en",
};

function inDays(d: number): string {
  return new Date(Date.now() + d * 86_400_000).toISOString();
}

/** Serialized properties of a minor live roadworks situation; `over` replaces any field. */
function props(over: Partial<RoadConditionEvent> = {}): Record<string, unknown> {
  const { geometry: _geometry, ...properties } = situation({
    kind: "roadworks",
    type: "works",
    severity: { label: "minor" },
    headline: text("Road works"),
    ...over,
  });
  return properties;
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
  popupHtml.mockClear();
  popupRemove.mockClear();
  respondWith([]);
  vi.stubGlobal("fetch", fetchMock);
  useRoadConditionsStore.setState({ panelOpen: true, layerVisible: true });
  useRoadConditionsStore.getState().resetFilters();
  useMapAttributionStore.setState({ byLayer: {} });
});

describe("RoadConditionsLayer rendered attribution", () => {
  it("credits no configured feed until its incident is rendered, and drops offscreen credits", async () => {
    respondWith(
      eventsToFeatureCollection([
        situation({
          id: "visible",
          source: "working",
          contributors: [{ sourceId: "working", name: "working" }],
        }),
        situation({
          id: "outside",
          source: "offscreen",
          contributors: [{ sourceId: "offscreen", name: "offscreen" }],
          geometry: { type: "Point", coordinates: [6, 53] },
        }),
      ]).features,
    );
    const view = render(
      <IntegrationRegistryContext.Provider value={creditRegistry}>
        <RoadConditionsLayer />
      </IntegrationRegistryContext.Provider>,
    );
    await waitFor(() => expect(sourceFeatures("Point")).toHaveLength(2));
    expect(
      Object.values(useMapAttributionStore.getState().byLayer)
        .flat()
        .map((entry) => entry.fullHtml)
        .join(" "),
    ).toBe("");

    const visible = sourceFeatures("Point").find((f) => f.properties?._id === "visible")!;
    fake.setRenderedFeatures(MARKER_LAYER, [
      {
        ...visible,
        layer: {
          id: MARKER_LAYER,
          type: "symbol",
          layout: { "icon-image": visible.properties?._icon, "icon-size": 0.55 },
        },
        source: SOURCE,
      } as never,
    ]);
    act(() => {
      fake.emit("sourcedata", { sourceId: SOURCE });
      fake.emit("render");
      fake.emit("idle");
    });
    await waitFor(() => {
      const html = Object.values(useMapAttributionStore.getState().byLayer)
        .flat()
        .map((entry) => entry.fullHtml)
        .join(" ");
      expect(html).toContain("working");
      expect(html).not.toContain("offscreen");
      expect(html).not.toContain("missing-key");
    });

    fetchMock.mockRejectedValueOnce(new Error("feed temporarily unavailable"));
    act(() => useRoadConditionsStore.setState({ horizon: "week" }));
    await waitFor(() =>
      expect(useRoadConditionsStore.getState().viewportFetchStatus).toBe("stale"),
    );
    act(() => {
      fake.emit("sourcedata", { sourceId: SOURCE });
      fake.emit("render");
    });
    await waitFor(() =>
      expect(
        Object.values(useMapAttributionStore.getState().byLayer)
          .flat()
          .map((entry) => entry.fullHtml)
          .join(" "),
      ).toContain("working"),
    );

    fake.setRenderedFeatures(MARKER_LAYER, []);
    act(() => {
      fake.emit("move");
      fake.emit("render");
    });
    await waitFor(() =>
      expect(
        Object.values(useMapAttributionStore.getState().byLayer)
          .flat()
          .map((entry) => entry.fullHtml),
      ).toEqual([]),
    );
    view.unmount();
  });
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
    const parsedStyle = fake.map.getStyle();
    vi.spyOn(fake.map, "getStyle").mockImplementation(() =>
      fake.state.styleLoaded ? parsedStyle : (undefined as never),
    );
    respondWith([
      {
        geometry: {
          type: "LineString",
          coordinates: [
            [13.4, 52.5],
            [13.41, 52.51],
          ],
        },
        properties: props({ id: "early" }),
      },
    ]);

    render(<RoadConditionsLayer />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fake.state.sources.has(SOURCE)).toBe(false);

    fake.state.styleLoaded = true;
    fake.emit("styledata");
    fake.emit("style.load");

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
            properties: props({ id: "new" }),
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
            properties: props({ id: "old" }),
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
        properties: props({ id: "last-good" }),
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

  it("rebuilds its layers with the last data after a style swap", async () => {
    respondWith([
      {
        geometry: { type: "Point", coordinates: [13.4, 52.5] },
        properties: props({ id: "kept" }),
      },
    ]);
    render(<RoadConditionsLayer />);
    await waitFor(() => {
      expect(sourceFeatures("Point")[0]?.properties?._id).toBe("kept");
    });

    act(() => {
      fake.map.setStyle({});
    });

    expect(fake.state.layers.has(MARKER_LAYER)).toBe(true);
    expect(fake.state.layers.has(LINE_LAYER)).toBe(true);
    await waitFor(() => {
      expect(sourceFeatures("Point")[0]?.properties?._id).toBe("kept");
    });
  });
});

describe("RoadConditionsLayer future styling", () => {
  it("stamps a `future` flag from a scheduled or forecast situation or a future start", async () => {
    respondWith([
      {
        geometry: { type: "Point", coordinates: [13.4, 52.5] },
        properties: props({ id: "flagged", temporality: "forecast" }),
      },
      {
        geometry: { type: "Point", coordinates: [13.405, 52.505] },
        properties: props({ id: "scheduled", temporality: "scheduled" }),
      },
      {
        geometry: { type: "Point", coordinates: [13.41, 52.51] },
        properties: props({ id: "dated", validity: { status: "planned", start: inDays(3) } }),
      },
      {
        geometry: { type: "Point", coordinates: [13.42, 52.52] },
        properties: props({ id: "current", validity: { status: "active", start: inDays(-3) } }),
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
    expect(byId.get("scheduled")).toBe(true);
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
        properties: props({ id: "line", validity: { status: "planned", start: inDays(3) } }),
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
        properties: props({
          id: "oc:1",
          source: "duesseldorf",
          groupId: "works-42",
          severity: { label: "moderate" },
          headline: text("Roadworks"),
        }),
      },
      {
        geometry: {
          type: "LineString",
          coordinates: itinerary.slice(5, 12),
        },
        properties: props({
          id: "oc:2",
          source: "duesseldorf",
          groupId: "works-42",
          severity: { label: "major" },
          headline: text("Lane closure"),
        }),
      },
      {
        geometry: { type: "LineString", coordinates: itinerary.slice(11) },
        properties: props({
          id: "oc:3",
          source: "duesseldorf",
          groupId: "works-42",
          severity: { label: "moderate" },
          headline: text("Roadworks"),
        }),
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
    const popupCard = buildIncidentCard(
      eventsByDisplayId.get("group:road-conditions-openconditions:duesseldorf:works-42") ?? [],
      cardInput,
      Date.now(),
    );
    expect(popupCard).toMatchObject({
      title: "type.works",
      severity: "major",
      headline: "Lane closure",
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
        properties: props({
          id: "congestion",
          source: "duesseldorf",
          groupId: "congestion-group",
          kind: "congestion",
          type: "congestion",
          severity: { label: "moderate" },
          headline: text("Traffic congestion"),
        }),
      },
      {
        geometry,
        properties: props({ id: "roadworks", source: "duesseldorf", groupId: "roadworks-group" }),
      },
    ]);

    const lines = (data as GeoJSON.FeatureCollection).features.filter(
      (feature) =>
        feature.geometry.type === "LineString" || feature.geometry.type === "MultiLineString",
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]?.properties).toMatchObject({
      severity: "moderate",
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

  it("reads mixed grouped source records as one condition on every road they name", () => {
    const validity = {
      status: "active" as const,
      start: "2026-06-22T05:00:00.000Z",
      end: "2026-09-01T15:00:00.000Z",
    };
    const events = [
      ["road-1", "roadworks.works", "Road works", "2922"],
      ["road-2", "roadworks.works", "Road works", "1002"],
      ["road-3", "roadworks.works", "Road works", "2119"],
      ["info-1", "other.other", "Traffic information", "2922"],
      ["info-2", "other.other", "Traffic information", "1002"],
      ["info-3", "other.other", "Traffic information", "2119"],
    ].map(([id, classification, headline, road]) => {
      const [kind = "", type = ""] = (classification ?? "").split(".");
      return situation({
        id,
        source: "duesseldorf",
        groupId: "situation-42",
        kind,
        type,
        severity: { label: "minor" },
        headline: text(headline ?? ""),
        geometry: {
          type: "LineString" as const,
          coordinates: [
            [6.77, 51.2],
            [6.771, 51.2],
          ],
        },
        roads: [{ ref: road, name: text(road ?? "") }],
        validity,
      });
    });

    const popupCard = buildIncidentCard(events, cardInput, Date.parse("2026-07-01T00:00:00Z"));

    expect(popupCard).toMatchObject({
      title: "type.works",
      where: "2922, 1002, 2119",
      headline: "Road works",
      when: "when.until",
    });
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
        properties: props({ id: "oc:endpoints", source: "duesseldorf" }),
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
  const FRESHNESS_DEADLINE_MS = 60_000;
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

  it("refreshes an open restriction popup through failure, recovery and withdrawal", async () => {
    const current = situation({
      id: "oc:situation:fi-digitraffic:GUID50465935",
      kind: "restriction",
      type: "dimension",
      geometry: { type: "Point", coordinates: [10.5, 45.5] },
      validity: { status: "active", start: new Date(Date.now() - 3_600_000).toISOString() },
      effects: [
        effect("GUID50465935/weight", "dimension_limit", {
          applicability: { kind: "classes", include: [{ class: "truck" }] },
          dimension: "gross_weight",
          value: { value: 26000, unit: "kg" },
          operator: "lte",
          meaning: "maximum_permitted",
        }),
      ],
    });
    respondWith(eventsToFeatureCollection([current]).features);
    render(<RoadConditionsLayer />);
    await flush();
    const marker = sourceFeatures("Point")[0]!;
    fake.setRenderedFeatures(MARKER_LAYER, [
      {
        ...marker,
        layer: { id: MARKER_LAYER, type: "symbol" },
        source: SOURCE,
        state: {},
      } as unknown as import("maplibre-gl").MapGeoJSONFeature,
    ]);
    await act(async () => {
      fake.emit("click", { point: { x: 10, y: 20 }, lngLat: { lng: 10.5, lat: 45.5 } });
    });
    expect(popupHtml).toHaveBeenCalledTimes(1);
    expect(popupHtml.mock.lastCall![0]).toContain("roadConditions.effect.dimension_limit");
    expect(popupHtml.mock.lastCall![0]).toContain("roadConditions.vehicle.truck");

    fetchMock.mockRejectedValueOnce(new Error("temporary outage"));
    await flush(FRESHNESS_DEADLINE_MS);
    expect(popupHtml.mock.lastCall![0]).toContain("roadConditions.freshness.needsRefresh");

    const ended = { ...current, validity: { ...current.validity, status: "ended" as const } };
    respondWith(eventsToFeatureCollection([ended]).features);
    await flush(FRESHNESS_DEADLINE_MS);
    expect(popupHtml.mock.lastCall![0]).toContain("roadConditions.validityStatus.ended");
    expect(popupHtml.mock.lastCall![0]).not.toContain("roadConditions.freshness.needsRefresh");

    respondWith([]);
    await flush(FRESHNESS_DEADLINE_MS);
    expect(popupRemove).toHaveBeenCalledTimes(1);
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
        properties: props({ id: "last-good" }),
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

it("reads each feature through the client's validating reader", () => {
  const served = situation({
    id: "source:record",
    kind: "closure",
    type: "closure",
    effects: [effect("c", "closure")],
    origin: "crowd",
    evidence: { state: "corroborated", confidenceScore: 0.4 },
    updatedAt: "2026-09-11T12:00:00Z",
    expiresAt: "2026-09-11T12:10:00Z",
  });
  const [feature] = eventsToFeatureCollection([served]).features;
  const result = buildSources([
    feature!,
    {
      geometry: { type: "Point", coordinates: [13, 52] },
      properties: props({ id: "x", validity: undefined }),
    },
    {
      geometry: { type: "Point", coordinates: [13, 52] },
      properties: { ...props({ id: "odd" }), effects: [{ id: "odd/1", kind: "teleport" }] },
    },
  ]);
  const events = [...result.eventsByDisplayId.values()].flat();
  // A situation without a readable validity cannot be shown truthfully.
  expect(events.map((event) => event.id)).toEqual(["source:record", "odd"]);
  expect(events[0]).toEqual(served);
  expect(events[1]?.effects).toEqual([
    expect.objectContaining({ id: "odd/1", kind: "unsupported" }),
  ]);
});

describe("road-condition restriction display boundary", () => {
  it("draws a closure that binds only some vehicles as a restriction marker", () => {
    const sources = buildSources([
      {
        geometry: { type: "Point", coordinates: [23.5, 60.1] },
        properties: props({
          id: "oc:situation:fi-digitraffic:GUID50465935",
          kind: "closure",
          type: "closure",
          severity: { label: "major" },
          effects: [
            effect("GUID50465935/closure", "closure", {
              applicability: { kind: "classes", include: [{ class: "hgv" }] },
            }),
          ],
        }),
      },
    ]);
    const collection = sources.data as { features: Array<{ properties: unknown }> };
    const marker = collection.features[0]!.properties as Record<string, unknown>;
    expect(marker._icon).toBe("rc:restriction:major");
    // Situations stay out of the marker; the popup reads them from the lookup.
    expect(marker).not.toHaveProperty("effects");
    const events = [...sources.eventsByDisplayId.values()].flat();
    expect(events[0]!.effects[0]?.applicability).toEqual({
      kind: "classes",
      include: [{ class: "hgv" }],
    });
  });
});

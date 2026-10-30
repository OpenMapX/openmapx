import { type EvChargeStop, useParkingStore } from "@openmapx/core";
import { act, fireEvent, render } from "@testing-library/react";
import type { MapGeoJSONFeature } from "maplibre-gl";
import { describe, expect, it, vi } from "vitest";
import { getMapClickOwner } from "@/integration-api/map/mapClickOwnership";
import { useMapAttributionStore } from "@/integration-api/overlay/mapAttributionStore";
import { createFakeMap, expectStyleSwapIsLossless } from "@/test";

const fake = createFakeMap({
  styleLoaded: true,
  project: (coordinate) => ({
    x: 100 + (coordinate[0] - 8) * 20000,
    y: 100 + (coordinate[1] - 50) * 20000,
  }),
  baseLayers: [{ id: "place-labels", type: "symbol" }],
});

const drawn = {
  routes: [
    {
      geometry: [
        [8, 50],
        [8, 50.02],
      ],
      distance: 2000,
      duration: 100,
      contributors: [{ sourceId: "a", name: "A", attributionText: "A notice" }],
    },
    {
      geometry: [
        [8, 50],
        [8.02, 50],
      ],
      distance: 2000,
      duration: 120,
      contributors: [{ sourceId: "b", name: "B", attributionText: "B notice" }],
    },
  ],
  activeRouteIndex: 0,
  provider: "routing-valhalla",
  mode: "driving",
  isEvMode: false,
  evStops: [] as EvChargeStop[],
  navigating: false,
};
const activateRoute = vi.hoisted(() => vi.fn());
const openCharger = vi.hoisted(() => vi.fn());
vi.mock("@/lib/openChargerPlace", () => ({
  EV_CHARGING_SOURCE_ID: "ev-charging",
  openChargerPlace: openCharger,
}));

vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({
    mapRef: { current: fake.map },
    mapReady: true,
    styleVersion: 0,
    fitBounds: vi.fn(),
  }),
}));
vi.mock("@/integration-api/map/useDrawnDirectionsRoutes", () => ({
  useDrawnDirectionsRoutes: () => drawn,
}));
vi.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations: () => (key: string, values?: Record<string, string>) =>
    values?.difference ?? values?.duration ?? key,
}));
vi.mock("maplibre-gl", () => ({
  Marker: class {
    constructor(private options: { element: HTMLElement }) {}
    setLngLat() {
      return this;
    }
    addTo() {
      fake.map.getCanvasContainer().append(this.options.element);
      return this;
    }
    remove() {
      this.options.element.remove();
    }
  },
}));
vi.mock("@/integration-api/overlay/useMapAttributions", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useMapAttributions: vi.fn(),
}));
vi.mock("@/lib/routeAttributions", () => ({
  routeAttributions: (
    _registry: unknown,
    _provider: unknown,
    route: { contributors?: unknown[] } | null,
  ) => route?.contributors ?? [],
}));
vi.mock("@openmapx/integration-framework/react", () => {
  const registry = {};
  return { useIntegrationRegistry: () => registry };
});
vi.mock("@openmapx/core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useDataSources: () => ({ data: { sources: [] } }),
  useDirectionsStore: () => ({
    waypoints: [{ coords: [8, 50] }],
    setActiveRouteIndex: activateRoute,
  }),
}));

import { RouteLayer } from "./RouteLayer";

describe("RouteLayer across a style change", () => {
  it("suppresses route badge pointer selection while picking but preserves keyboard selection", async () => {
    activateRoute.mockClear();
    const view = render(<RouteLayer />);
    await act(async () => {});
    const button = fake.map.getCanvasContainer().querySelector<HTMLButtonElement>("button");
    expect(button).not.toBeNull();
    useParkingStore.getState().setPicking(true);
    fireEvent.click(button as HTMLButtonElement);
    expect(activateRoute).not.toHaveBeenCalled();
    fireEvent.keyDown(button as HTMLButtonElement, { key: "Enter" });
    expect(activateRoute).toHaveBeenCalledTimes(1);
    view.unmount();
    useParkingStore.getState().reset();
  });
  it("claims clicks on either route badge from the map", async () => {
    activateRoute.mockClear();
    const view = render(<RouteLayer />);
    await act(async () => {});
    const canvasContainer = fake.map.getCanvasContainer();
    const mapClickOwners: unknown[] = [];
    const mapClick = (event: Event) => mapClickOwners.push(getMapClickOwner(event));
    canvasContainer.addEventListener("click", mapClick);
    const pills = [...canvasContainer.querySelectorAll<HTMLElement>(".omx-route-map-pill")];
    expect(new Set(pills.map((pill) => pill.tagName))).toEqual(new Set(["SPAN", "BUTTON"]));
    for (const pill of pills) fireEvent.click(pill);
    expect(activateRoute).toHaveBeenCalledTimes(1);
    expect(mapClickOwners).toEqual(["marker", "marker"]);
    canvasContainer.removeEventListener("click", mapClick);
    view.unmount();
  });
  it("keeps the drawn route", () => {
    render(<RouteLayer />);
    const before = fake.state.sources.get("route-source")?.data as { features: unknown[] };
    expect(before.features.length).toBeGreaterThan(0);
    expectStyleSwapIsLossless(fake);
  });
});

it("publishes each alternate route's captured suppliers into its geometry", () => {
  const view = render(<RouteLayer />);
  const data = fake.state.sources.get("route-source")?.data as {
    features: { properties: { routeIndex: number; _mapAttributions: string } }[];
  };
  for (const feature of data.features) {
    expect(JSON.parse(feature.properties._mapAttributions)).toEqual(
      drawn.routes[feature.properties.routeIndex].contributors,
    );
  }
  view.unmount();
});

it("credits a rendered alternate independently of the active route and retains owner isolation", () => {
  vi.useFakeTimers();
  useMapAttributionStore.setState({
    byLayer: { base: [{ fullHtml: "Base map credit", visibleHtml: "Base map credit", logos: [] }] },
  });
  const first = render(<RouteLayer />);
  const second = render(<RouteLayer />);
  const data = fake.state.sources.get("route-source")?.data as {
    features: { properties: { routeIndex: number } }[];
  };
  fake.setRenderedFeatures(
    "route-alt-line",
    data.features.filter(
      (feature) => feature.properties.routeIndex === 1,
    ) as unknown as MapGeoJSONFeature[],
  );
  const flush = () =>
    act(() => {
      fake.emit("render");
      vi.advanceTimersByTime(250);
    });
  const html = () =>
    Object.values(useMapAttributionStore.getState().byLayer)
      .flat()
      .map((entry) => entry.fullHtml)
      .join(" ");
  flush();
  expect(html()).toContain("B notice");
  expect(html()).not.toContain("A notice");
  first.unmount();
  second.rerender(<RouteLayer />);
  flush();
  expect(html()).toContain("B notice");
  fake.setRenderedFeatures("route-alt-line", []);
  flush();
  expect(html()).toBe("Base map credit");
  second.unmount();
  vi.useRealTimers();
});

it("credits only charge-pin geometry and status, retaining separate preview fields", async () => {
  const position = { sourceId: "position", name: "Pin position" };
  const status = { sourceId: "status", name: "Pin status" };
  const hidden = { sourceId: "model", name: "Hidden model" };
  const oldStops = drawn.evStops;
  const oldEv = drawn.isEvMode;
  const stop: EvChargeStop = {
    station: {
      id: "charger",
      name: "Charger",
      coordinates: [8, 50],
      contributors: [position],
      fieldContributors: { id: [position], name: [position], coordinates: [position] },
    },
    connector: "ccs2",
    powerKw: 150,
    arriveSocPct: 20,
    departSocPct: 80,
    chargeSeconds: 100,
    addedKwh: 40,
    availability: { available: 1, total: 1 },
    attributions: [],
    contributors: [position, status, hidden],
    fieldContributors: {
      "station.coordinates": [position],
      availability: [status],
      chargeSeconds: [hidden],
    },
  };
  let view: ReturnType<typeof render> | undefined;
  try {
    drawn.isEvMode = true;
    drawn.evStops = [stop];
    view = render(<RouteLayer />);
    await act(async () => {});
    const data = fake.state.sources.get("ev-stops-source")?.data as GeoJSON.FeatureCollection;
    const receipt = JSON.parse(data.features[0].properties?._mapAttributions ?? "[]");
    expect(receipt).toEqual([position, status]);
    fake.setRenderedFeatures("ev-stops-layer", data.features as MapGeoJSONFeature[]);
    openCharger.mockClear();
    // The hit feature carries the old receipt even if current planner props changed.
    drawn.evStops = [
      { ...stop, station: { ...stop.station, name: "New name", contributors: [hidden] } },
    ];
    fake.emit("click", { point: { x: 100, y: 100 } });
    expect(openCharger).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "charger",
        name: "Charger",
        contributors: [position],
        fieldContributors: { id: [position], name: [position], coordinates: [position] },
      }),
      expect.objectContaining({}),
    );
  } finally {
    view?.unmount();
    drawn.evStops = oldStops;
    drawn.isEvMode = oldEv;
  }
});

it("credits only queried chunks of a composed route, independently of total-duration pills", () => {
  vi.useFakeTimers();
  const original = drawn.routes;
  const a = { sourceId: "same", name: "Supplier", attributionText: "A section" };
  const b = { sourceId: "same", name: "Supplier", attributionText: "B section" };
  // No finite duration: no pill is painted, leaving geometry as the only owner.
  drawn.routes = [
    {
      ...original[0],
      duration: Number.NaN,
      geometry: [
        [8, 50],
        [9, 50],
        [10, 50],
      ],
      contributors: [a, b],
    },
  ];
  Object.assign(drawn.routes[0], {
    geometryContributors: [
      { startIndex: 0, endIndex: 1, contributors: [a] },
      { startIndex: 1, endIndex: 2, contributors: [b] },
    ],
  });
  const view = render(<RouteLayer />);
  const data = fake.state.sources.get("route-source")?.data as { features: MapGeoJSONFeature[] };
  expect(data.features).toHaveLength(2);
  for (const [indices, expected, absent] of [
    [[0], ["A section"], ["B section"]],
    [[1], ["B section"], ["A section"]],
    [[0, 1], ["A section", "B section"], []],
    [[], [], ["A section", "B section"]],
  ] as const) {
    fake.setRenderedFeatures(
      "route-active-line",
      indices.map((i) => data.features[i]),
    );
    act(() => {
      fake.emit("render");
      vi.advanceTimersByTime(250);
    });
    const html = Object.values(useMapAttributionStore.getState().byLayer)
      .flat()
      .map((entry) => entry.fullHtml)
      .join(" ");
    for (const notice of expected) expect(html).toContain(notice);
    for (const notice of absent) expect(html).not.toContain(notice);
  }
  view.unmount();
  drawn.routes = original;
  vi.useRealTimers();
});

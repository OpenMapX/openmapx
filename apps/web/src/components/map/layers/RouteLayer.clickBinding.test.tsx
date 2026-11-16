import type { EvChargeStop } from "@openmapx/core";
import { act, render } from "@testing-library/react";
import type { MapGeoJSONFeature } from "maplibre-gl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INTERACTIVE_LAYER_IDS } from "@/integration-api/map/interactiveLayers";
import { createFakeMap } from "@/test";

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

// One ref object for the whole file, like MapProvider's useRef. A fresh
// `{ current }` per render would re-run every mapRef-keyed effect and hide
// a missing readiness dependency.
const mapContext: {
  mapRef: { current: unknown };
  mapReady: boolean;
  styleVersion: number;
} = { mapRef: { current: null }, mapReady: false, styleVersion: 0 };
const fitBounds = vi.fn();
vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({
    mapRef: mapContext.mapRef,
    mapReady: mapContext.mapReady,
    styleVersion: mapContext.styleVersion,
    fitBounds,
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

const position = { sourceId: "position", name: "Pin position" };
const status = { sourceId: "status", name: "Pin status" };
const hidden = { sourceId: "model", name: "Hidden model" };
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

const altClick = () => ({
  point: { x: 100, y: 100 },
  lngLat: { lng: 8.01, lat: 50 },
  originalEvent: new MouseEvent("click"),
  features: [{ properties: { routeIndex: 1 } }],
});

// Mirrors MapCanvas: the map is assigned after async work, then readiness
// is published, which re-renders every useMap() consumer.
async function makeMapReady(view: ReturnType<typeof render>) {
  mapContext.mapRef.current = fake.map;
  mapContext.mapReady = true;
  view.rerender(<RouteLayer />);
  await act(async () => {});
}
const calls = (method: "on" | "off", event: string, layerId: string) =>
  fake.state.listenerCalls.filter(
    (c) => c.method === method && c.event === event && c.layerId === layerId,
  );

function showEvStopUnderPointer() {
  const data = fake.state.sources.get("ev-stops-source")?.data as GeoJSON.FeatureCollection;
  fake.setRenderedFeatures("ev-stops-layer", data.features as MapGeoJSONFeature[]);
}

describe("RouteLayer map click binding", () => {
  beforeEach(() => {
    mapContext.mapRef.current = null;
    mapContext.mapReady = false;
    mapContext.styleVersion = 0;
    fake.state.listenerCalls.length = 0;
    activateRoute.mockClear();
    openCharger.mockClear();
    drawn.isEvMode = false;
    drawn.evStops = [];
  });
  afterEach(() => {
    drawn.isEvMode = false;
    drawn.evStops = [];
    fake.setRenderedFeatures("ev-stops-layer", []);
  });

  it("binds the alternative-route click once the map becomes ready, and unbinds on unmount", async () => {
    const view = render(<RouteLayer />);
    try {
      await act(async () => {});
      expect(calls("on", "click", "route-alt-line")).toHaveLength(0);
      await makeMapReady(view);
      const bound = calls("on", "click", "route-alt-line");
      expect(bound).toHaveLength(1);
      const handler = bound[0].handler;
      act(() => handler(altClick()));
      expect(activateRoute).toHaveBeenCalledWith(1);
      view.unmount();
      expect(calls("off", "click", "route-alt-line").some((c) => c.handler === handler)).toBe(true);
    } finally {
      view.unmount();
    }
  });

  it("binds the EV charge-stop pin handlers once the map becomes ready", async () => {
    drawn.isEvMode = true;
    drawn.evStops = [stop];
    const view = render(<RouteLayer />);
    try {
      await act(async () => {});
      for (const event of ["click", "mouseenter", "mouseleave"]) {
        expect(calls("on", event, "ev-stops-layer")).toHaveLength(0);
      }
      await makeMapReady(view);
      for (const event of ["click", "mouseenter", "mouseleave"]) {
        expect(calls("on", event, "ev-stops-layer")).toHaveLength(1);
      }
      showEvStopUnderPointer();
      const handler = calls("on", "click", "ev-stops-layer")[0].handler;
      act(() => handler({ point: { x: 100, y: 100 } }));
      expect(openCharger).toHaveBeenCalledWith(
        expect.objectContaining({ id: "charger", name: "Charger" }),
        expect.any(Object),
      );
    } finally {
      view.unmount();
    }
  });

  it("registers the alternative line and charge-stop pins as interactive layers while mounted", async () => {
    const view = render(<RouteLayer />);
    try {
      await makeMapReady(view);
      expect(INTERACTIVE_LAYER_IDS.has("route-alt-line")).toBe(true);
      expect(INTERACTIVE_LAYER_IDS.has("ev-stops-layer")).toBe(true);
      view.unmount();
      expect(INTERACTIVE_LAYER_IDS.has("route-alt-line")).toBe(false);
      expect(INTERACTIVE_LAYER_IDS.has("ev-stops-layer")).toBe(false);
    } finally {
      view.unmount();
    }
  });

  it("an alternative still selects after registering itself, but yields to an EV pin drawn over it", async () => {
    drawn.isEvMode = true;
    drawn.evStops = [stop];
    const view = render(<RouteLayer />);
    try {
      await makeMapReady(view);
      const handler = calls("on", "click", "route-alt-line")[0]?.handler;
      expect(handler).toBeDefined();
      act(() => handler(altClick()));
      expect(activateRoute).toHaveBeenCalledWith(1);
      activateRoute.mockClear();
      showEvStopUnderPointer();
      act(() => handler(altClick()));
      expect(activateRoute).not.toHaveBeenCalled();
    } finally {
      view.unmount();
    }
  });
});

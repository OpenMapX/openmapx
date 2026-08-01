import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeMap } from "@/test";

const fake = createFakeMap({ styleLoaded: true });

const drawn = {
  routes: [
    {
      geometry: [
        [8, 50],
        [8, 50.02],
      ],
      distance: 2000,
      duration: 100,
    },
    {
      geometry: [
        [8, 50],
        [8.02, 50],
      ],
      distance: 2000,
      duration: 120,
    },
  ],
  activeRouteIndex: 0,
  provider: "routing-valhalla",
  mode: "driving",
  isEvMode: false,
  evStops: [],
  navigating: false,
};

vi.mock("@/lib/MapContext", () => ({
  useMap: () => ({ mapRef: { current: fake.map }, mapReady: true, styleVersion: 0 }),
}));
vi.mock("@/lib/useDrawnDirectionsRoutes", () => ({
  useDrawnDirectionsRoutes: () => drawn,
}));
vi.mock("@/lib/useIntegrationAttribution", () => ({
  useIntegrationDomainAttribution: vi.fn(),
}));

const useRouteFlow = vi.fn(() => ({
  r0: [{ startMeters: 200, endMeters: 900, los: "queuing", confidence: "measured" }],
}));
vi.mock("@openmapx/core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useRouteFlow: (...args: unknown[]) => useRouteFlow(...(args as [])),
}));

import type { NavProgress, Route } from "@openmapx/core";
import { useNavigationStore } from "@openmapx/core";
import { ROUTE_WIDTHS } from "@/lib/routeStyle";
import { RouteTrafficLayer } from "./RouteTrafficLayer";
import { buildBandFeatures } from "./routeFlowBands";

const NAV_ROUTE = {
  geometry: [
    [8, 50],
    [8, 50.02],
  ],
  distance: 2000,
  duration: 100,
} as unknown as Route;

const SPANS = {
  r0: [
    { startMeters: 200, endMeters: 900, los: "queuing" as const, confidence: "measured" as const },
  ],
};

describe("RouteTrafficLayer", () => {
  afterEach(() => {
    useNavigationStore.getState().stopNavigation();
    drawn.mode = "driving";
  });

  it("creates both band layers in their slots", () => {
    render(<RouteTrafficLayer />);
    expect(fake.state.layers.has("route-traffic-active")).toBe(true);
    expect(fake.state.layers.has("route-traffic-alt")).toBe(true);
  });

  it("paints bands sliced from the active route", () => {
    render(<RouteTrafficLayer />);
    const source = fake.state.sources.get("route-traffic-source");
    const data = source?.data as GeoJSON.FeatureCollection;
    expect(data.features.length).toBeGreaterThan(0);
    expect(data.features[0].properties?.variant).toBe("active");
  });

  it("asks for flow on the alternates as well as the active route", () => {
    render(<RouteTrafficLayer />);
    const [routes] = useRouteFlow.mock.calls[useRouteFlow.mock.calls.length - 1] as [
      Array<{ id: string }>,
      boolean,
    ];
    expect(routes.map((r) => r.id)).toEqual(["r0", "r1"]);
  });

  it("widens bands and clips the active route to alongMeters while navigating", () => {
    useNavigationStore.getState().startGroundNavigation(NAV_ROUTE, "driving", [
      [8, 50],
      [8, 50.02],
    ]);
    useNavigationStore.getState().applyProgress({ alongMeters: 300 } as NavProgress);

    render(<RouteTrafficLayer />);

    expect(fake.state.paint.get("route-traffic-active")?.["line-width"]).toBe(
      ROUTE_WIDTHS.nav.line,
    );
    expect(fake.state.paint.get("route-traffic-alt")?.["line-width"]).toBe(
      ROUTE_WIDTHS.nav.altLine,
    );

    const data = fake.state.sources.get("route-traffic-source")?.data as GeoJSON.FeatureCollection;
    const activeFeature = data.features.find((f) => f.properties?.variant === "active");
    expect(activeFeature).toBeDefined();

    // The pure slicer (tested on its own in routeFlowBands.test.ts) is the oracle
    // here: trimmed uses the alongMeters this component is supposed to pass
    // through, untrimmed is what the same span would look like without it. If
    // the component failed to thread alongMeters into the render input, the
    // painted geometry would match "untrimmed" instead.
    const trimmed = buildBandFeatures(
      [{ id: "r0", geometry: NAV_ROUTE.geometry, variant: "active", alongMeters: 300 }],
      SPANS,
    );
    const untrimmed = buildBandFeatures(
      [{ id: "r0", geometry: NAV_ROUTE.geometry, variant: "active" }],
      SPANS,
    );
    const activeCoords = (activeFeature?.geometry as GeoJSON.LineString).coordinates;
    expect(activeCoords).toEqual((trimmed.features[0].geometry as GeoJSON.LineString).coordinates);
    expect(activeCoords).not.toEqual(
      (untrimmed.features[0].geometry as GeoJSON.LineString).coordinates,
    );
  });

  it("draws no bands for a non-motorised mode and clears any previously drawn ones", () => {
    const { rerender } = render(<RouteTrafficLayer />);
    const before = fake.state.sources.get("route-traffic-source")
      ?.data as GeoJSON.FeatureCollection;
    expect(before.features.length).toBeGreaterThan(0);

    drawn.mode = "walking";
    rerender(<RouteTrafficLayer />);

    const after = fake.state.sources.get("route-traffic-source")?.data as GeoJSON.FeatureCollection;
    expect(after.features).toHaveLength(0);
  });

  it("never lets alongMeters reach the polled query, even while navigating", () => {
    useNavigationStore.getState().startGroundNavigation(NAV_ROUTE, "driving", [
      [8, 50],
      [8, 50.02],
    ]);
    useNavigationStore.getState().applyProgress({ alongMeters: 300 } as NavProgress);

    render(<RouteTrafficLayer />);

    const [routes] = useRouteFlow.mock.calls[useRouteFlow.mock.calls.length - 1] as [
      Array<Record<string, unknown>>,
      boolean,
    ];
    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) {
      expect(Object.keys(route).sort()).toEqual(["geometry", "id"]);
      expect("alongMeters" in route).toBe(false);
    }
  });
});

import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeMap, expectStyleSwapIsLossless } from "@/test";

const fake = createFakeMap({
  styleLoaded: true,
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

// A stable object, not a fresh `{ current: fake.map }` literal per call: several
// map hooks key an effect's teardown on `mapRef`'s identity, and a re-render
// (e.g. `rerender()` in the 100-update tests below) must not look like the map
// itself changed.
const mapRef: { current: unknown } = { current: fake.map };
vi.mock("@/lib/MapContext", () => ({
  useMap: () => ({ mapRef, mapReady: true, styleVersion: 0 }),
}));
vi.mock("@/lib/useDrawnDirectionsRoutes", () => ({
  useDrawnDirectionsRoutes: () => drawn,
}));
vi.mock("@/lib/useIntegrationAttribution", () => ({
  useIntegrationDomainAttribution: vi.fn(),
}));

// A stable object, not a fresh literal per call: real `useRouteFlow` is
// backed by `useQuery`, which keeps the same `data` reference across
// re-renders that don't produce a new query result. A mock that hands back a
// fresh object every call would make the component's own span-derived memos
// (`staticFeatures` in particular) look unstable when they are not.
const SPANS_RESULT = {
  r0: [{ startMeters: 200, endMeters: 900, los: "queuing", confidence: "measured" }],
};
const useRouteFlow = vi.fn(() => SPANS_RESULT);
vi.mock("@openmapx/core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useRouteFlow: (...args: unknown[]) => useRouteFlow(...(args as [])),
}));

import type { NavProgress, Route } from "@openmapx/core";
import { useNavigationStore } from "@openmapx/core";
import { ROUTE_WIDTHS } from "@/lib/routeStyle";
import { RouteTrafficLayer } from "./RouteTrafficLayer";
import { activeSpanFilter, buildCurrentSpanFeatures } from "./routeFlowBands";

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

  it("widens bands and moves the active route's current span into the current-span source while navigating", () => {
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
    expect(fake.state.paint.get("route-traffic-current")?.["line-width"]).toBe(
      ROUTE_WIDTHS.nav.line,
    );

    // The static source stays untrimmed — the boundary at `alongMeters` is a
    // filter/current-source concern, not something baked into its geometry.
    const staticData = fake.state.sources.get("route-traffic-source")
      ?.data as GeoJSON.FeatureCollection;
    const staticActive = staticData.features.find((f) => f.properties?.variant === "active");
    expect(staticActive?.properties?.startMeters).toBe(200);

    // The active layer's filter must exclude that same span (its startMeters,
    // 200, is behind alongMeters, 300) so it is not drawn twice.
    expect(fake.state.filters.get("route-traffic-active")).toEqual(activeSpanFilter(300));

    // The pure slicer (tested on its own in routeFlowBands.test.ts) is the
    // oracle for what the trimmed current-span geometry should be. If the
    // component failed to thread alongMeters through, the current source
    // would stay empty instead.
    const currentData = fake.state.sources.get("route-traffic-current-source")
      ?.data as GeoJSON.FeatureCollection;
    const trimmed = buildCurrentSpanFeatures(
      { id: "r0", geometry: NAV_ROUTE.geometry, variant: "active" },
      SPANS.r0,
      300,
    );
    expect(currentData.features).toHaveLength(1);
    expect((currentData.features[0].geometry as GeoJSON.LineString).coordinates).toEqual(
      (trimmed[0].geometry as GeoJSON.LineString).coordinates,
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

  it("keeps the congestion bands across a style change", () => {
    render(<RouteTrafficLayer />);
    const before = fake.state.sources.get("route-traffic-source")?.data as { features: unknown[] };
    expect(before.features.length).toBeGreaterThan(0);
    expectStyleSwapIsLossless(fake);
  });

  it("keeps useRouteFlow's routes array identity stable, never re-publishes the static traffic source, and never removes/re-adds a traffic layer across 100 progress updates", () => {
    useNavigationStore.getState().startGroundNavigation(NAV_ROUTE, "driving", [
      [8, 50],
      [8, 50.02],
    ]);
    useNavigationStore.getState().applyProgress({ alongMeters: 0 } as NavProgress);
    useRouteFlow.mockClear();

    const { rerender } = render(<RouteTrafficLayer />);
    const firstRoutesArg = useRouteFlow.mock.calls.at(-1)?.[0];
    expect(firstRoutesArg).toBeDefined();
    // Fresh window: an earlier test's mount may have already bumped these
    // once, which is not what this test is checking.
    fake.state.counts.setData.delete("route-traffic-source");
    fake.state.counts.setData.delete("route-traffic-current-source");
    fake.state.counts.removeLayer.delete("route-traffic-active");
    fake.state.counts.removeLayer.delete("route-traffic-alt");
    fake.state.counts.removeLayer.delete("route-traffic-current");

    for (let i = 1; i <= 100; i++) {
      act(() => {
        useNavigationStore.getState().applyProgress({ alongMeters: i * 10 } as NavProgress);
      });
      rerender(<RouteTrafficLayer />);
    }

    for (const call of useRouteFlow.mock.calls) {
      expect(call[0]).toBe(firstRoutesArg);
    }
    expect(fake.state.counts.setData.get("route-traffic-source")).toBeUndefined();
    // The current source is expected to update — at most once per progress
    // change, never more.
    expect(fake.state.counts.setData.get("route-traffic-current-source") ?? 0).toBeLessThanOrEqual(
      100,
    );
    expect(fake.state.counts.removeLayer.get("route-traffic-active")).toBeUndefined();
    expect(fake.state.counts.removeLayer.get("route-traffic-alt")).toBeUndefined();
    expect(fake.state.counts.removeLayer.get("route-traffic-current")).toBeUndefined();
  });

  it("restores the latest (not zero-progress) active filter across two consecutive style swaps at mid-route progress, with traffic spans present", () => {
    useNavigationStore.getState().startGroundNavigation(NAV_ROUTE, "driving", [
      [8, 50],
      [8, 50.02],
    ]);
    useNavigationStore.getState().applyProgress({ alongMeters: 300 } as NavProgress);
    render(<RouteTrafficLayer />);

    const expectedFilter = activeSpanFilter(300);
    expect(fake.state.filters.get("route-traffic-active")).toEqual(expectedFilter);
    // Sanity: not the zero-progress filter shape.
    expect(expectedFilter).not.toEqual(["==", ["get", "variant"], "active"]);

    act(() => {
      fake.map.setStyle({} as never);
    });
    expect(fake.state.layers.has("route-traffic-active")).toBe(true);
    expect(fake.state.layers.has("route-traffic-alt")).toBe(true);
    expect(fake.state.layers.has("route-traffic-current")).toBe(true);
    expect(fake.state.sources.has("route-traffic-source")).toBe(true);
    expect(fake.state.sources.has("route-traffic-current-source")).toBe(true);
    expect(fake.state.filters.get("route-traffic-active")).toEqual(expectedFilter);

    // A second consecutive swap: expectStyleSwapIsLossless snapshots the
    // current (already-restored) state — including slot ordering and the
    // live filter — swaps again, and checks it comes back identical.
    expectStyleSwapIsLossless(fake);
    expect(fake.state.filters.get("route-traffic-active")).toEqual(expectedFilter);
  });
});

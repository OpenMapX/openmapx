import { numberAt, routeWidthExpression } from "@openmapx/core";
import { act, render } from "@testing-library/react";
import { lineString } from "@turf/helpers";
import length from "@turf/length";
import type { MapGeoJSONFeature } from "maplibre-gl";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { layerRegistrations } from "@/integration-api/map/layerStack";
import { useNavigationSceneStore } from "@/integration-api/map/navigationScene";
import { useMapAttributionStore } from "@/integration-api/overlay/mapAttributionStore";
import { ROUTE_COLORS } from "@/lib/routeStyle";
import { createFakeMap, expectStyleSwapIsLossless, nth } from "@/test";

const fake = createFakeMap({
  styleLoaded: true,
  baseLayers: [{ id: "place-labels", type: "symbol" }],
});

const route = {
  geometry: [
    [8, 50],
    [8, 50.01],
    [8, 50.02],
  ],
  distance: 2200,
  duration: 120,
  contributors: [{ sourceId: "same", name: "Supplier", attributionText: "captured notice" }],
};

const navState = {
  status: "navigating",
  route,
  routes: [route],
  activeRouteIndex: 0,
  progress: { alongMeters: 0 },
  routeProvider: "routing-valhalla",
  fasterRoute: null,
  selectRoute: vi.fn(),
};

// A stable object, not a fresh `{ current: fake.map }` literal per call: several
// map hooks key an effect's teardown on `mapRef`'s identity, and a re-render
// (e.g. `rerender()` in the 100-update tests below) must not look like the map
// itself changed.
const mapRef: { current: unknown } = { current: fake.map };
let mapReady = true;
vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ mapRef, mapReady, styleVersion: 0 }),
}));
vi.mock("@/integration-api/overlay/useMapAttributions", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useMapAttributions: vi.fn(),
}));
const renderedAttributionCalls: unknown[][] = [];
vi.mock("@/integration-api/overlay/useRenderedMapAttributions", async (importOriginal) => {
  const original = await importOriginal<{
    useRenderedMapAttributions: (...args: unknown[]) => unknown;
  }>();
  return {
    ...original,
    useRenderedMapAttributions: (...args: unknown[]) => {
      renderedAttributionCalls.push(args);
      return original.useRenderedMapAttributions(...args);
    },
  };
});
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
  useNavigationStore: Object.assign(
    (selector: (s: typeof navState) => unknown) => selector(navState),
    { getState: () => navState },
  ),
}));

import { NavigationRouteLayer } from "./NavigationRouteLayer";
import {
  buildNavRouteLine,
  type NavRouteLine,
  navRouteProgressFraction,
  splitNavRoute,
} from "./navRouteSplit";

const REMAINING = "nav-route-remaining";
const SOURCE = "nav-route-source";
const TRAVELED = "nav-route-traveled";
const REMAINING_CASING = "nav-route-remaining-casing";

/** The `f` boundary out of a `["step", ["line-progress"], v0, f, v1]` gradient. */
function gradientFraction(layerId: string): number {
  const gradient = fake.state.paint.get(layerId)?.["line-gradient"] as unknown[] | undefined;
  const fraction = gradient?.[3];
  assert(typeof fraction === "number", `${layerId} has no step gradient`);
  return fraction;
}

// Independent of navRouteSplit.ts's own projectX/projectY (not imported from
// there), same rationale as navRouteSplit.test.ts: reconstructing the point a
// `line-progress` fraction refers to from scratch is what makes this an actual
// check on the component's wiring, rather than something that would agree with
// itself even if the wiring were wrong.
function unprojectX(x: number): number {
  return (x - 0.5) * 360;
}
function unprojectY(y: number): number {
  const s = Math.tanh(Math.PI * (1 - 2 * y));
  return (Math.asin(s) * 180) / Math.PI;
}
function projectX(lng: number): number {
  return lng / 360 + 0.5;
}
function projectY(lat: number): number {
  const sin = Math.sin((lat * Math.PI) / 180);
  const y = 0.5 - (0.25 * Math.log((1 + sin) / (1 - sin))) / Math.PI;
  return y < 0 ? 0 : Math.min(y, 1);
}
function reconstructPositionFromFraction(
  prepared: NavRouteLine,
  fraction: number,
): [number, number] {
  const target = fraction * prepared.mercatorTotal;
  const coords = prepared.line.geometry.coordinates;
  const { mercatorCumulative } = prepared;
  let segIdx = mercatorCumulative.length - 2;
  for (let i = 0; i < mercatorCumulative.length - 1; i++) {
    if (target <= nth(mercatorCumulative, i + 1)) {
      segIdx = i;
      break;
    }
  }
  const segStart = nth(coords, segIdx);
  const segEnd = nth(coords, segIdx + 1);
  const startX = projectX(numberAt(segStart, 0));
  const startY = projectY(numberAt(segStart, 1));
  const segMercLen = nth(mercatorCumulative, segIdx + 1) - nth(mercatorCumulative, segIdx);
  const ratio = segMercLen > 1e-12 ? (target - nth(mercatorCumulative, segIdx)) / segMercLen : 0;
  const mx = startX + ratio * (projectX(numberAt(segEnd, 0)) - startX);
  const my = startY + ratio * (projectY(numberAt(segEnd, 1)) - startY);
  return [unprojectX(mx), unprojectY(my)];
}
function metersBetween(a: number[], b: number[]): number {
  return length(lineString([a, b]), { units: "kilometers" }) * 1000;
}

const preparedRoute = buildNavRouteLine(route.geometry as [number, number][]);
if (!preparedRoute) throw new Error("expected a prepared line");
const routeTotalMeters = preparedRoute.lengthKm * 1000;

describe("NavigationRouteLayer across a style change", () => {
  it("loses nothing at all across a style change", () => {
    render(<NavigationRouteLayer />);
    expectStyleSwapIsLossless(fake);
  });

  it("does not touch the route source or remove/re-add its casing/traveled/remaining layers across 100 progress updates", () => {
    const { rerender } = render(<NavigationRouteLayer />);
    // Fresh window: an earlier test in this file may have already bumped
    // these on its own initial mount, which is unrelated to what this test
    // checks (whether *progress* updates cause any of this).
    fake.state.counts.setData.delete(SOURCE);
    fake.state.counts.removeLayer.delete(TRAVELED);
    fake.state.counts.removeLayer.delete(REMAINING);
    fake.state.counts.removeLayer.delete(REMAINING_CASING);

    for (let i = 1; i <= 100; i++) {
      navState.progress = { alongMeters: i * 20 };
      rerender(<NavigationRouteLayer />);
    }

    expect(fake.state.counts.setData.get(SOURCE)).toBeUndefined();
    expect(fake.state.counts.removeLayer.get(TRAVELED)).toBeUndefined();
    expect(fake.state.counts.removeLayer.get(REMAINING)).toBeUndefined();
    expect(fake.state.counts.removeLayer.get(REMAINING_CASING)).toBeUndefined();

    navState.progress = { alongMeters: 0 };
  });
});

describe("NavigationRouteLayer progress-driven gradients", () => {
  afterEach(() => {
    navState.progress = { alongMeters: 0 };
  });

  it("moves the line-gradient stop to the same point splitNavRoute's traveled/remaining boundary cuts at", () => {
    const { rerender } = render(<NavigationRouteLayer />);

    for (const ratio of [0, 0.5, 1]) {
      const alongMeters = routeTotalMeters * ratio;
      navState.progress = { alongMeters };
      rerender(<NavigationRouteLayer />);

      const f = gradientFraction(REMAINING);
      expect(f).toBeCloseTo(navRouteProgressFraction(preparedRoute, alongMeters), 10);

      const traveled = splitNavRoute(
        route.geometry as [number, number][],
        alongMeters,
        preparedRoute,
      ).find((feat) => feat.properties?.kind === "traveled") as
        | GeoJSON.Feature<GeoJSON.LineString>
        | undefined;
      if (!traveled) continue; // ratio 0: nothing traveled yet, nothing to reconstruct against.
      const coords = traveled.geometry.coordinates;
      const cutPoint = nth(coords, coords.length - 1);
      const reconstructed = reconstructPositionFromFraction(preparedRoute, f);
      expect(metersBetween(cutPoint, reconstructed)).toBeLessThan(1);
    }
  });

  it("colors traveled fully transparent and remaining fully active at the start of the route", () => {
    navState.progress = { alongMeters: 0 };
    render(<NavigationRouteLayer />);

    expect(fake.state.paint.get(TRAVELED)?.["line-gradient"]).toEqual([
      "step",
      ["line-progress"],
      ROUTE_COLORS.traveled,
      0,
      "rgba(0,0,0,0)",
    ]);
    expect(fake.state.paint.get(REMAINING)?.["line-gradient"]).toEqual([
      "step",
      ["line-progress"],
      "rgba(0,0,0,0)",
      0,
      ROUTE_COLORS.active,
    ]);
  });

  it("colors traveled fully and remaining fully transparent at the end of the route", () => {
    navState.progress = { alongMeters: routeTotalMeters };
    render(<NavigationRouteLayer />);

    expect(gradientFraction(TRAVELED)).toBe(1);
    expect(gradientFraction(REMAINING)).toBe(1);
  });

  it("moves the casing gradient identically to the remaining gradient", () => {
    const { rerender } = render(<NavigationRouteLayer />);

    for (const ratio of [0, 0.3, 0.7, 1]) {
      navState.progress = { alongMeters: routeTotalMeters * ratio };
      rerender(<NavigationRouteLayer />);
      expect(gradientFraction(REMAINING_CASING)).toBe(gradientFraction(REMAINING));
    }
  });

  it("keeps 11/7/8 px widths below the lane crossover, opacity, ids and slot order", () => {
    render(<NavigationRouteLayer />);

    // [interpolate, exponential, zoom, z0, low-zoom width, z1, …]
    const lowZoomWidth = (id: string) =>
      (fake.state.paint.get(id)?.["line-width"] as unknown[] | undefined)?.[4];
    expect(lowZoomWidth(REMAINING_CASING)).toBe(11);
    expect(lowZoomWidth(TRAVELED)).toBe(7);
    expect(fake.state.paint.get(TRAVELED)?.["line-opacity"]).toBe(0.7);
    expect(lowZoomWidth(REMAINING)).toBe(8);
    expect(fake.state.paint.get(REMAINING)?.["line-width"]).toEqual(
      routeWidthExpression(8, 3.2, 50),
    );

    const order = [...fake.state.layers.keys()];
    expect(order.indexOf(REMAINING_CASING)).toBeLessThan(order.indexOf(TRAVELED));
    expect(order.indexOf(TRAVELED)).toBeLessThan(order.indexOf(REMAINING));
  });

  it("restores the latest (not zero-progress) gradients across two consecutive style swaps at mid-route progress", () => {
    const alongMeters = routeTotalMeters * 0.4;
    navState.progress = { alongMeters };
    render(<NavigationRouteLayer />);
    const expectedF = navRouteProgressFraction(preparedRoute, alongMeters);
    // Sanity: not the boundary values a zero-progress gradient would have.
    expect(expectedF).toBeGreaterThan(0);
    expect(expectedF).toBeLessThan(1);

    act(() => {
      fake.map.setStyle({} as never);
    });
    expect(gradientFraction(REMAINING)).toBeCloseTo(expectedF, 10);
    expect(gradientFraction(TRAVELED)).toBeCloseTo(expectedF, 10);
    expect(gradientFraction(REMAINING_CASING)).toBeCloseTo(expectedF, 10);

    // A second consecutive swap: expectStyleSwapIsLossless snapshots the
    // current (already-restored) state, swaps again, and checks it comes
    // back identical — including the live `line-gradient` paint value.
    expectStyleSwapIsLossless(fake);
    expect(gradientFraction(REMAINING)).toBeCloseTo(expectedF, 10);
  });
});

it("publishes the navigation route snapshot once while progress only updates paint", () => {
  const view = render(<NavigationRouteLayer />);
  const data = fake.state.sources.get(SOURCE)?.data as {
    features: { properties: { _mapAttributions: string } }[];
  };
  expect(JSON.parse(nth(data.features, 0).properties._mapAttributions)).toEqual(route.contributors);
  const initial = fake.state.sources.get(SOURCE)?.data;
  navState.progress = { alongMeters: 500 };
  view.rerender(<NavigationRouteLayer />);
  expect(fake.state.sources.get(SOURCE)?.data).toBe(initial);
  view.unmount();
});

it("credits only actual line hits through progress, empty viewport and unrelated loading", () => {
  vi.useFakeTimers();
  useMapAttributionStore.setState({
    byLayer: { base: [{ fullHtml: "Base map credit", visibleHtml: "Base map credit", logos: [] }] },
  });
  const originalReceipts = route.contributors;
  route.contributors = [
    ...originalReceipts,
    { sourceId: "same", name: "Supplier", attributionText: "second required notice" },
  ];
  const view = render(<NavigationRouteLayer />);
  const data = fake.state.sources.get(SOURCE)?.data as { features: unknown[] };
  fake.setRenderedFeatures(TRAVELED, data.features as MapGeoJSONFeature[]);
  const styleDescriptor = Object.getOwnPropertyDescriptor(fake.map, "style");
  Object.defineProperty(fake.map, "style", {
    configurable: true,
    value: {
      projection: { worldCoordinateHelper: {} },
      tileManagers: {
        [SOURCE]: {
          getVisibleCoordinates: () => [{}],
          getTile: () => ({
            hasData: () => true,
            querySourceFeatures: (records: unknown[]) => records.push(...data.features),
            getBucket: () => ({
              uploaded: true,
              isEmpty: () => false,
              gradients: Object.fromEntries(
                [TRAVELED, REMAINING, REMAINING_CASING].map((id) => [
                  id,
                  {
                    gradient: { data: new Uint8Array([255, 0, 0, 255, 255, 0, 0, 0]) },
                    texture: {},
                  },
                ]),
              ),
            }),
          }),
        },
      },
    },
  });
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
  expect(html()).toContain("captured notice");
  expect(html()).toContain("second required notice");
  fake.state.styleLoaded = false;
  navState.progress = { alongMeters: 999999 };
  view.rerender(<NavigationRouteLayer />);
  flush();
  expect(html()).toContain("captured notice");
  fake.setRenderedFeatures(TRAVELED, []);
  flush();
  expect(html()).toBe("Base map credit");
  view.unmount();
  route.contributors = originalReceipts;
  fake.state.styleLoaded = true;
  if (styleDescriptor) Object.defineProperty(fake.map, "style", styleDescriptor);
  else Reflect.deleteProperty(fake.map, "style");
  vi.useRealTimers();
});

it("draws captured route segments with global progress and no GPS geometry uploads", () => {
  const a = { sourceId: "a", name: "A" },
    b = { sourceId: "b", name: "B" };
  Object.assign(route, {
    geometryContributors: [
      { startIndex: 0, endIndex: 1, contributors: [a] },
      { startIndex: 1, endIndex: 2, contributors: [b] },
    ],
  });
  navState.progress = { alongMeters: routeTotalMeters * 0.75 };
  const view = render(<NavigationRouteLayer />);
  const data = fake.state.sources.get(SOURCE)?.data as {
    features: { geometry: { coordinates: number[][] }; properties: { _mapAttributions: string } }[];
  };
  expect(data.features.map((f) => JSON.parse(f.properties._mapAttributions))).toEqual([[a], [b]]);
  expect(data.features.map((f) => f.geometry.coordinates)).toEqual([
    route.geometry.slice(0, 2),
    route.geometry.slice(1),
  ]);
  expect(gradientFraction(REMAINING)).toBeGreaterThan(1);
  expect(gradientFraction(`${REMAINING}-1`)).toBeCloseTo(0.5, 2);
  fake.state.counts.setData.delete(SOURCE);
  for (let i = 0; i < 100; i++) {
    navState.progress = { alongMeters: i * 10 };
    view.rerender(<NavigationRouteLayer />);
  }
  expect(fake.state.counts.setData.get(SOURCE) ?? 0).toBe(0);
  expectStyleSwapIsLossless(fake);
  view.unmount();
  Reflect.deleteProperty(route, "geometryContributors");
  navState.progress = { alongMeters: 0 };
});

it("projects alternative and proposed geometry with the same captured span contract", () => {
  const originalRoutes = navState.routes;
  const a = { sourceId: "a", name: "A" },
    b = { sourceId: "b", name: "B" };
  const alternative = {
    ...route,
    geometryContributors: [
      { startIndex: 0, endIndex: 1, contributors: [a] },
      { startIndex: 1, endIndex: 2, contributors: [b] },
    ],
  };
  navState.routes = [route, alternative];
  Object.assign(navState, { fasterRoute: { route: alternative } });
  const view = render(<NavigationRouteLayer />);
  const data = fake.state.sources.get("nav-route-alts-source")?.data as {
    features: { properties: { kind: string; routeIndex?: number; _mapAttributions: string } }[];
  };
  expect(
    data.features.map((f) => [f.properties.kind, JSON.parse(f.properties._mapAttributions)]),
  ).toEqual([
    ["alt", [a]],
    ["alt", [b]],
    ["proposed", [a]],
    ["proposed", [b]],
  ]);
  expect(data.features.slice(0, 2).every((f) => f.properties.routeIndex === 1)).toBe(true);
  view.unmount();
  navState.routes = originalRoutes;
  navState.fasterRoute = null;
});

describe("NavigationRouteLayer in 3D navigation", () => {
  const GHOST = "nav-route-remaining-ghost";

  afterEach(() => {
    act(() => useNavigationSceneStore.getState().setActive(false));
    navState.progress = { alongMeters: 0 };
  });

  it("adds ghost layers in route-ghost only while the navigation scene is active", () => {
    render(<NavigationRouteLayer />);
    expect(fake.state.layers.has(GHOST)).toBe(false);
    act(() => useNavigationSceneStore.getState().setActive(true));
    expect(fake.state.layers.has(GHOST)).toBe(true);
    expect(layerRegistrations().find((r) => r.id === GHOST)).toMatchObject({
      slot: "route-ghost",
      order: 0,
    });
    expect(fake.state.paint.get(GHOST)?.["line-opacity"]).toBe(0.35);
    // The remaining line's progress gradient, without a casing.
    expect(fake.state.paint.get(GHOST)?.["line-gradient"]).toEqual(
      fake.state.paint.get(REMAINING)?.["line-gradient"],
    );
  });

  it("a new ghost layer starts transparent, so its first frame paints no travelled route", () => {
    render(<NavigationRouteLayer />);
    const added: Record<string, unknown>[] = [];
    const addLayer = fake.map.addLayer.bind(fake.map);
    const spy = vi.spyOn(fake.map, "addLayer").mockImplementation((layer, before) => {
      added.push(layer as unknown as Record<string, unknown>);
      return addLayer(layer, before);
    });
    act(() => useNavigationSceneStore.getState().setActive(true));
    spy.mockRestore();
    const ghost = added.find((layer) => layer.id === GHOST) as
      | { paint: Record<string, unknown> }
      | undefined;
    expect(ghost?.paint["line-color"]).toBe("rgba(0,0,0,0)");
  });

  it("ghost removed when it ends", () => {
    render(<NavigationRouteLayer />);
    act(() => useNavigationSceneStore.getState().setActive(true));
    act(() => useNavigationSceneStore.getState().setActive(false));
    expect(fake.state.layers.has(GHOST)).toBe(false);
  });

  it("ghost layers join the rendered-attribution gradient groups only while present", () => {
    render(<NavigationRouteLayer />);
    const groups = () => {
      const call = renderedAttributionCalls.filter((args) => args[0] === "nav-route").at(-1);
      return (call?.[3] as { complementaryGradientGroups: string[][] }).complementaryGradientGroups;
    };
    expect(groups().flat()).not.toContain(GHOST);
    act(() => useNavigationSceneStore.getState().setActive(true));
    expect(groups()[0]).toContain(GHOST);
    act(() => useNavigationSceneStore.getState().setActive(false));
    expect(groups().flat()).not.toContain(GHOST);
  });

  it("highlight span adds transparent stops without a setData call", () => {
    const { rerender } = render(<NavigationRouteLayer />);
    navState.progress = { alongMeters: 300 };
    rerender(<NavigationRouteLayer />);
    fake.state.counts.setData.delete(SOURCE);
    act(() => {
      useNavigationSceneStore.getState().setActive(true);
      useNavigationSceneStore.getState().setHighlightSpan({ fromAlong: 900, toAlong: 1100 });
    });
    const remaining = fake.state.paint.get(REMAINING)?.["line-gradient"] as unknown[];
    const casing = fake.state.paint.get(REMAINING_CASING)?.["line-gradient"] as unknown[];
    const ghost = fake.state.paint.get(GHOST)?.["line-gradient"] as unknown[];
    const progress = navRouteProgressFraction(preparedRoute, 300);
    const from = navRouteProgressFraction(preparedRoute, 900);
    const to = navRouteProgressFraction(preparedRoute, 1100);
    expect(remaining).toEqual([
      "step",
      ["line-progress"],
      "rgba(0,0,0,0)",
      progress,
      ROUTE_COLORS.active,
      from,
      "rgba(0,0,0,0)",
      to,
      ROUTE_COLORS.active,
    ]);
    expect(casing.slice(5)).toEqual([from, "rgba(0,0,0,0)", to, ROUTE_COLORS.casing]);
    // The ghost keeps covering the geometry, so the attribution union stays whole.
    expect(ghost).toHaveLength(5);
    expect(fake.state.counts.setData.get(SOURCE)).toBeUndefined();
  });

  it("the ghost leaves the raised arrow's span transparent, so the arrow stays white", () => {
    const { rerender } = render(<NavigationRouteLayer />);
    navState.progress = { alongMeters: 300 };
    rerender(<NavigationRouteLayer />);
    act(() => {
      useNavigationSceneStore.getState().setActive(true);
      useNavigationSceneStore.getState().setArrowSpan({ fromAlong: 950, toAlong: 1050 });
    });
    const ghost = fake.state.paint.get(GHOST)?.["line-gradient"] as unknown[];
    const from = navRouteProgressFraction(preparedRoute, 950);
    const to = navRouteProgressFraction(preparedRoute, 1050);
    expect(ghost.slice(5)).toEqual([from, "rgba(0,0,0,0)", to, ROUTE_COLORS.active]);
    // The opaque route under the arrow is untouched.
    expect(fake.state.paint.get(REMAINING)?.["line-gradient"]).toHaveLength(5);
  });

  it("toggling the ghost does not call setData on nav-route-source", () => {
    render(<NavigationRouteLayer />);
    fake.state.counts.setData.delete(SOURCE);
    act(() => useNavigationSceneStore.getState().setActive(true));
    act(() => useNavigationSceneStore.getState().setActive(false));
    expect(fake.state.counts.setData.get(SOURCE)).toBeUndefined();
  });

  it("latitude change under 1° does not rebuild the width expression", () => {
    navState.progress = { alongMeters: 0, snapped: [8, 50] } as typeof navState.progress;
    const { rerender } = render(<NavigationRouteLayer />);
    const before = fake.state.paint.get(REMAINING)?.["line-width"];
    navState.progress = { alongMeters: 10, snapped: [8, 50.6] } as typeof navState.progress;
    rerender(<NavigationRouteLayer />);
    expect(fake.state.paint.get(REMAINING)?.["line-width"]).toEqual(before);
    navState.progress = { alongMeters: 20, snapped: [8, 51.2] } as typeof navState.progress;
    rerender(<NavigationRouteLayer />);
    expect(fake.state.paint.get(REMAINING)?.["line-width"]).toEqual(
      routeWidthExpression(8, 3.2, 51.2),
    );
  });
});

describe("NavigationRouteLayer alternative taps", () => {
  it("binds the alternative tap once the map becomes ready, and unbinds on unmount", () => {
    const calls = (method: "on" | "off", event: string) =>
      fake.state.listenerCalls.filter(
        (c) => c.method === method && c.event === event && c.layerId === "nav-route-alts",
      );
    try {
      mapRef.current = null;
      mapReady = false;
      fake.state.listenerCalls.length = 0;
      navState.selectRoute.mockClear();
      const view = render(<NavigationRouteLayer />);
      expect(calls("on", "click")).toHaveLength(0);
      mapRef.current = fake.map;
      mapReady = true;
      view.rerender(<NavigationRouteLayer />);
      expect(calls("on", "click")).toHaveLength(1);
      expect(calls("on", "mouseenter")).toHaveLength(1);
      expect(calls("on", "mouseleave")).toHaveLength(1);
      const handler = nth(calls("on", "click"), 0).handler;
      act(() =>
        handler({
          originalEvent: new MouseEvent("click"),
          point: { x: 1, y: 1 },
          features: [{ properties: { routeIndex: 1 } }],
        }),
      );
      expect(navState.selectRoute).toHaveBeenCalledWith(1);
      view.unmount();
      expect(calls("off", "click").some((c) => c.handler === handler)).toBe(true);
    } finally {
      mapRef.current = fake.map;
      mapReady = true;
    }
  });
});

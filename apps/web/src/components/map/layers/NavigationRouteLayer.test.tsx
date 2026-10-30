import { act, render } from "@testing-library/react";
import { lineString } from "@turf/helpers";
import length from "@turf/length";
import type { MapGeoJSONFeature } from "maplibre-gl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMapAttributionStore } from "@/integration-api/overlay/mapAttributionStore";
import { ROUTE_COLORS } from "@/lib/routeStyle";
import { createFakeMap, expectStyleSwapIsLossless } from "@/test";

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
vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ mapRef, mapReady: true, styleVersion: 0 }),
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

function featureCount(): number {
  const data = fake.state.sources.get(SOURCE)?.data as { features?: unknown[] } | undefined;
  return data?.features?.length ?? 0;
}

/** The `f` boundary out of a `["step", ["line-progress"], v0, f, v1]` gradient. */
function gradientFraction(layerId: string): number {
  const gradient = fake.state.paint.get(layerId)?.["line-gradient"] as unknown[] | undefined;
  return gradient?.[3] as number;
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
  return y < 0 ? 0 : y > 1 ? 1 : y;
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
    if (target <= mercatorCumulative[i + 1]) {
      segIdx = i;
      break;
    }
  }
  const segStart = coords[segIdx];
  const segEnd = coords[segIdx + 1];
  const segMercLen = mercatorCumulative[segIdx + 1] - mercatorCumulative[segIdx];
  const ratio = segMercLen > 1e-12 ? (target - mercatorCumulative[segIdx]) / segMercLen : 0;
  const mx = projectX(segStart[0]) + ratio * (projectX(segEnd[0]) - projectX(segStart[0]));
  const my = projectY(segStart[1]) + ratio * (projectY(segEnd[1]) - projectY(segStart[1]));
  return [unprojectX(mx), unprojectY(my)];
}
function metersBetween(a: [number, number], b: [number, number]): number {
  return length(lineString([a, b]), { units: "kilometers" }) * 1000;
}

const preparedRoute = buildNavRouteLine(route.geometry as [number, number][]);
if (!preparedRoute) throw new Error("expected a prepared line");
const routeTotalMeters = preparedRoute.lengthKm * 1000;

describe("NavigationRouteLayer across a style change", () => {
  it("draws the route line while navigating", () => {
    render(<NavigationRouteLayer />);
    expect(fake.state.layers.has(REMAINING)).toBe(true);
    expect(featureCount()).toBeGreaterThan(0);
  });

  it("rebuilds its layers after a theme swap without waiting for a new styleVersion", () => {
    render(<NavigationRouteLayer />);
    act(() => {
      fake.map.setStyle({} as never);
    });
    // A dark-mode swap calls setStyle, which drops every source and layer. The
    // styleVersion counter is driven by a one-shot listener that can be missed,
    // so recovery has to come from the map's own styledata event.
    expect(fake.state.layers.has(REMAINING)).toBe(true);
  });

  it("re-pushes the route geometry after a theme swap, not just the empty layers", () => {
    render(<NavigationRouteLayer />);
    act(() => {
      fake.map.setStyle({} as never);
    });
    // Recreating the source leaves it empty; without a re-push the driver sees
    // no route line until something else happens to change the geometry.
    expect(featureCount()).toBeGreaterThan(0);
  });

  it("loses nothing at all across a style change", () => {
    render(<NavigationRouteLayer />);
    expectStyleSwapIsLossless(fake);
  });

  it("keeps the alternates and the active route across two consecutive style changes", () => {
    render(<NavigationRouteLayer />);
    act(() => {
      fake.map.setStyle({} as never);
    });
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
      const cutPoint = coords[coords.length - 1] as [number, number];
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

  it("keeps casing/traveled/remaining widths, opacity, ids and slot order exactly as before", () => {
    render(<NavigationRouteLayer />);

    expect(fake.state.paint.get(REMAINING_CASING)?.["line-width"]).toBe(11);
    expect(fake.state.paint.get(TRAVELED)?.["line-width"]).toBe(7);
    expect(fake.state.paint.get(TRAVELED)?.["line-opacity"]).toBe(0.7);
    expect(fake.state.paint.get(REMAINING)?.["line-width"]).toBe(8);

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
  expect(JSON.parse(data.features[0].properties._mapAttributions)).toEqual(route.contributors);
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

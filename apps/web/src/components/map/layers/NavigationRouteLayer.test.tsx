import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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

vi.mock("@/lib/MapContext", () => ({
  useMap: () => ({ mapRef: { current: fake.map }, mapReady: true, styleVersion: 0 }),
}));
vi.mock("@/lib/useMapAttributions", () => ({ useMapAttributions: vi.fn() }));
vi.mock("@/lib/attributionForProviders", () => ({ attributionsForProviders: () => [] }));
vi.mock("@openmapx/integration-framework/react", () => ({ useIntegrationRegistry: () => ({}) }));
vi.mock("@openmapx/core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useNavigationStore: Object.assign(
    (selector: (s: typeof navState) => unknown) => selector(navState),
    { getState: () => navState },
  ),
}));

import { NavigationRouteLayer } from "./NavigationRouteLayer";

const REMAINING = "nav-route-remaining";
const SOURCE = "nav-route-source";

function featureCount(): number {
  const data = fake.state.sources.get(SOURCE)?.data as { features?: unknown[] } | undefined;
  return data?.features?.length ?? 0;
}

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
});

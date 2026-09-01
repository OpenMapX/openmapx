import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
vi.mock("@/integration-api/overlay/useMapAttributions", () => ({ useMapAttributions: vi.fn() }));
vi.mock("@/lib/attributionForProviders", () => ({ attributionsForProviders: () => [] }));
vi.mock("@openmapx/integration-framework/react", () => ({ useIntegrationRegistry: () => ({}) }));
vi.mock("@openmapx/core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useDataSources: () => ({ data: { sources: [] } }),
  useDirectionsStore: () => ({ waypoints: [{ coords: [8, 50] }], setActiveRouteIndex: vi.fn() }),
}));

import { RouteLayer } from "./RouteLayer";

describe("RouteLayer across a style change", () => {
  it("keeps the drawn route", () => {
    render(<RouteLayer />);
    const before = fake.state.sources.get("route-source")?.data as { features: unknown[] };
    expect(before.features.length).toBeGreaterThan(0);
    expectStyleSwapIsLossless(fake);
  });
});

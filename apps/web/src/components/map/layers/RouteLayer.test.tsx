import { useParkingStore } from "@openmapx/core";
import { act, fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
const activateRoute = vi.hoisted(() => vi.fn());

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
vi.mock("@/integration-api/overlay/useMapAttributions", () => ({ useMapAttributions: vi.fn() }));
vi.mock("@/lib/attributionForProviders", () => ({ attributionsForProviders: () => [] }));
vi.mock("@openmapx/integration-framework/react", () => ({ useIntegrationRegistry: () => ({}) }));
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
  it("keeps the drawn route", () => {
    render(<RouteLayer />);
    const before = fake.state.sources.get("route-source")?.data as { features: unknown[] };
    expect(before.features.length).toBeGreaterThan(0);
    expectStyleSwapIsLossless(fake);
  });
});

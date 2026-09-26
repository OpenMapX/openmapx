import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeMap } from "@/test";

const fake = createFakeMap({
  styleLoaded: true,
  project: ([lng, lat]) => ({ x: 200 + lng * 600, y: 200 + lat * 300 }),
});

vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ mapRef: { current: fake.map }, mapReady: true, fitBounds: vi.fn() }),
}));
vi.mock("@/integration-api/map/useDrawnDirectionsRoutes", () => ({
  useDrawnDirectionsRoutes: () => ({
    routes: [
      {
        geometry: [
          [0, 0],
          [1, 1],
        ],
        duration: 1200,
        distance: 2000,
      },
    ],
    activeRouteIndex: 0,
    provider: "routing-valhalla",
    mode: "driving",
    isEvMode: false,
    evStops: [],
    navigating: false,
  }),
}));
vi.mock("@/integration-api/overlay/useMapAttributions", () => ({ useMapAttributions: vi.fn() }));
vi.mock("@/lib/attributionForProviders", () => ({ attributionsForProviders: () => [] }));
vi.mock("@openmapx/integration-framework/react", () => ({ useIntegrationRegistry: () => ({}) }));
vi.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations: () => (_key: string, values?: Record<string, string>) => values?.duration ?? "",
}));
vi.mock("maplibre-gl", () => {
  throw new Error("marker module unavailable");
});
vi.mock("@openmapx/core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useDataSources: () => ({ data: { sources: [] } }),
  useDirectionsStore: () => ({ waypoints: [{ coords: [0, 0] }], setActiveRouteIndex: vi.fn() }),
}));

import { RouteLayer } from "./RouteLayer";

afterEach(cleanup);

describe("RouteLayer marker loading", () => {
  it("reports a missing Marker module and retries on a later map move", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      render(<RouteLayer />);
      await waitFor(() =>
        expect(error).toHaveBeenCalledWith(
          expect.stringContaining("route pills"),
          expect.any(Error),
        ),
      );
      fake.emit("moveend");
      await waitFor(() => expect(error).toHaveBeenCalledTimes(2));
    } finally {
      error.mockRestore();
    }
  });
});

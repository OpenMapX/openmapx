import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { publishMapObstruction } from "@/lib/mapObstructions";
import { createFakeMap, expectStyleSwapIsLossless } from "@/test";
import { routePillAnchors } from "./routePillAnchors";

const fake = createFakeMap({
  styleLoaded: true,
  containerWidth: 1200,
  containerHeight: 800,
  project: ([lng, lat]) => ({ x: 300 + lng * 600, y: 300 + lat * 500 }),
  baseLayers: [{ id: "place-labels", type: "symbol" }],
});
const selectRoute = vi.fn();
const drawn = {
  routes: [
    {
      geometry: [
        [0.4, 0],
        [0.6, 0.2],
        [1, 0.2],
      ],
      distance: 2000,
      duration: 1200,
    },
    {
      geometry: [
        [0.4, 0],
        [0.6, 0.45],
        [1, 0.45],
      ],
      distance: 2100,
      duration: 1500,
    },
  ],
  activeRouteIndex: 0,
  provider: "routing-valhalla",
  mode: "driving",
  isEvMode: false,
  evStops: [],
  navigating: false,
};
let locale = "en";

vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ mapRef: { current: fake.map }, mapReady: true, fitBounds: vi.fn() }),
}));
vi.mock("@/integration-api/map/useDrawnDirectionsRoutes", () => ({
  useDrawnDirectionsRoutes: () => drawn,
}));
vi.mock("@/integration-api/overlay/useMapAttributions", () => ({ useMapAttributions: vi.fn() }));
vi.mock("@/lib/attributionForProviders", () => ({ attributionsForProviders: () => [] }));
vi.mock("@openmapx/integration-framework/react", () => ({ useIntegrationRegistry: () => ({}) }));
vi.mock("next-intl", () => ({
  useLocale: () => locale,
  useTranslations: () => (key: string, values?: Record<string, string>) => {
    if (key === "mapRouteSameTime") return locale === "de" ? "Gleiche Dauer" : "Same time";
    if (key === "mapRouteSelect")
      return locale === "de"
        ? `Route wählen, ${values?.difference}`
        : `Select route, ${values?.difference}`;
    return key;
  },
}));
vi.mock("maplibre-gl", () => ({
  Marker: class {
    private element: HTMLElement;
    constructor(options: { element: HTMLElement }) {
      this.element = options.element;
    }
    setLngLat(coords: [number, number]) {
      this.element.dataset.lngLat = coords.join(",");
      return this;
    }
    addTo() {
      document.body.appendChild(this.element);
      return this;
    }
    remove() {
      this.element.remove();
    }
  },
}));
vi.mock("@openmapx/core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useDataSources: () => ({ data: { sources: [] } }),
  useDirectionsStore: () => ({
    waypoints: [{ coords: [0.4, 0] }],
    setActiveRouteIndex: selectRoute,
  }),
}));

import { RouteLayer } from "./RouteLayer";

afterEach(() => {
  cleanup();
  publishMapObstruction("task24-test", "left", null);
  drawn.activeRouteIndex = 0;
  drawn.navigating = false;
  drawn.mode = "driving";
  drawn.routes = [
    {
      geometry: [
        [0.4, 0],
        [0.6, 0.2],
        [1, 0.2],
      ],
      distance: 2000,
      duration: 1200,
    },
    {
      geometry: [
        [0.4, 0],
        [0.6, 0.45],
        [1, 0.45],
      ],
      distance: 2100,
      duration: 1500,
    },
  ];
  locale = "en";
  selectRoute.mockClear();
});

describe("RouteLayer map pills", () => {
  it("shows selected duration and a selectable alternative delta without duplicating on a style swap", async () => {
    const { rerender } = render(<RouteLayer />);
    expect(await screen.findByText("20 min")).toBeInTheDocument();
    const alternative = screen.getByRole("button", { name: "Select route, +5 min" });
    fireEvent.click(alternative);
    expect(selectRoute).toHaveBeenCalledTimes(1);
    expect(selectRoute).toHaveBeenCalledWith(1);

    drawn.activeRouteIndex = 1;
    rerender(<RouteLayer />);
    expect(await screen.findByText("25 min")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Select route, −5 min" })).toBeInTheDocument();
    expectStyleSwapIsLossless(fake);
    expect(screen.getAllByText("25 min")).toHaveLength(1);
    const survivingAlternative = screen.getByRole("button", { name: "Select route, −5 min" });
    fireEvent.click(survivingAlternative);
    expect(selectRoute).toHaveBeenCalledTimes(2);
    expect(selectRoute).toHaveBeenLastCalledWith(0);
  });

  it("clears pills during navigation and when the planning mode changes", async () => {
    const { rerender, unmount } = render(<RouteLayer />);
    expect(await screen.findByText("20 min")).toBeInTheDocument();
    drawn.navigating = true;
    rerender(<RouteLayer />);
    await waitFor(() => expect(screen.queryByText("20 min")).not.toBeInTheDocument());
    drawn.navigating = false;
    drawn.mode = "transit";
    rerender(<RouteLayer />);
    expect(screen.queryByText("20 min")).not.toBeInTheDocument();
    drawn.mode = "driving";
    rerender(<RouteLayer />);
    expect(await screen.findByText("20 min")).toBeInTheDocument();
    unmount();
    expect(screen.queryByText("20 min")).not.toBeInTheDocument();
  });

  it("keeps labels outside opaque desktop rails and the mobile sheet", async () => {
    const { rerender } = render(<RouteLayer />);
    expect(await screen.findByText("20 min")).toBeInTheDocument();
    act(() => publishMapObstruction("task24-test", "left", 800));
    rerender(<RouteLayer />);
    await waitFor(() => {
      const pills = document.querySelectorAll<HTMLElement>(".omx-route-map-pill");
      expect(pills.length).toBeGreaterThan(0);
      for (const pill of pills) {
        const [lng, lat] = (pill.dataset.lngLat ?? "").split(",").map(Number);
        expect(fake.map.project([lng, lat]).x).toBeGreaterThan(800);
      }
    });
    act(() => publishMapObstruction("task24-test", "bottom", 470));
    rerender(<RouteLayer />);
    await waitFor(() => {
      const pills = document.querySelectorAll<HTMLElement>(".omx-route-map-pill");
      expect(pills.length).toBeGreaterThan(0);
      for (const pill of pills) {
        const [lng, lat] = (pill.dataset.lngLat ?? "").split(",").map(Number);
        expect(fake.map.project([lng, lat]).y).toBeLessThan(330);
      }
    });
  });

  it("places a selected pill on a bent segment and suppresses identical alternatives", async () => {
    drawn.routes = [
      {
        geometry: [
          [0.4, 0],
          [0.6, 0.4],
          [1, 0.4],
        ],
        distance: 2000,
        duration: 1200,
      },
      {
        geometry: [
          [0.4, 0],
          [0.6, 0.4],
          [1, 0.4],
        ],
        distance: 2000,
        duration: 1500,
      },
    ];
    render(<RouteLayer />);
    const selected = await screen.findByText("20 min");
    const pill = selected.closest(".omx-route-map-pill") as HTMLElement;
    const [lng, lat] = (pill.dataset.lngLat ?? "").split(",").map(Number);
    const onFirstSegment = lng >= 0.4 && lng <= 0.6 && Math.abs(lat - 2 * (lng - 0.4)) < 0.0001;
    const onSecondSegment = lng >= 0.6 && lng <= 1 && Math.abs(lat - 0.4) < 0.0001;
    expect(onFirstSegment || onSecondSegment).toBe(true);
    expect(screen.queryByRole("button", { name: /Select route/ })).not.toBeInTheDocument();
  });

  it("suppresses a near-overlapping alternative while keeping a distinct one selectable", async () => {
    drawn.routes = [
      {
        geometry: [
          [0.4, 0],
          [0.6, 0.2],
          [1, 0.2],
        ],
        distance: 2000,
        duration: 1200,
      },
      {
        geometry: [
          [0.4, 0.01],
          [0.6, 0.21],
          [1, 0.21],
        ],
        distance: 2050,
        duration: 1260,
      },
      {
        geometry: [
          [0.4, 0],
          [0.6, 0.45],
          [1, 0.45],
        ],
        distance: 2100,
        duration: 1500,
      },
    ];
    render(<RouteLayer />);
    expect(await screen.findByText("20 min")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Select route, +1 min" })).not.toBeInTheDocument();
    const distinct = screen.getByRole("button", { name: "Select route, +5 min" });
    fireEvent.click(distinct);
    expect(selectRoute).toHaveBeenCalledWith(2);
  });

  it("localizes equal-time pills and keeps alternative buttons keyboard-selectable", async () => {
    locale = "de";
    drawn.routes[1].duration = 1200;
    render(<RouteLayer />);
    const same = await screen.findByRole("button", { name: "Route wählen, Gleiche Dauer" });
    same.focus();
    await userEvent.keyboard("{Enter}");
    expect(selectRoute).toHaveBeenCalledTimes(1);
    expect(selectRoute).toHaveBeenCalledWith(1);
  });

  it("rejects invalid and zero-length geometry after running the anchor selector", () => {
    const result = routePillAnchors(
      [
        {
          routeIndex: 0,
          geometry: [
            [0.4, 0],
            [0.4, 0],
          ],
          width: 64,
        },
        {
          routeIndex: 1,
          geometry: [
            [Number.NaN, 0],
            [0.8, 0.2],
          ],
          width: 64,
        },
      ],
      0,
      ([lng, lat]) => ({ x: 300 + lng * 600, y: 300 + lat * 500 }),
      { width: 1200, height: 800, insets: { top: 0, bottom: 0, left: 0, right: 0 } },
    );
    expect(result).toEqual([]);
  });

  it("omits an alternative with unknown duration after the marker module resolves", async () => {
    drawn.routes = [
      {
        geometry: [
          [0.4, 0],
          [1, 0.2],
        ],
        distance: 2000,
        duration: 1200,
      },
      {
        geometry: [
          [0.4, 0],
          [1, 0.4],
        ],
        distance: 2000,
        duration: Number.NaN,
      },
    ];
    render(<RouteLayer />);
    expect(await screen.findByText("20 min")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Select route/ })).not.toBeInTheDocument();
  });
});

import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createFakeMap } from "@/test";

const fake = createFakeMap({
  styleLoaded: true,
  baseLayers: [
    { id: "water", type: "fill" },
    { id: "place-labels", type: "symbol" },
  ],
});

vi.mock("@/lib/MapContext", () => ({
  useMap: () => ({
    mapRef: { current: fake.map },
    mapReady: true,
    styleVersion: 0,
    fitBounds: vi.fn(),
    flyTo: vi.fn(),
  }),
}));
vi.mock("@/lib/useMapAttributions", () => ({ useMapAttributions: vi.fn() }));
vi.mock("@/lib/attributionForProviders", () => ({ attributionsForProviders: () => [] }));
vi.mock("@/lib/useIntegrationAttribution", () => ({ useIntegrationDomainAttribution: vi.fn() }));
vi.mock("@openmapx/integration-framework/react", () => ({ useIntegrationRegistry: () => ({}) }));
vi.mock("@/lib/navigation/useNavTrafficSignals", () => ({
  useNavTrafficSignals: () => [[8, 50] as [number, number]],
}));
vi.mock("@/lib/trafficLightMarker", () => ({
  TRAFFIC_LIGHT_IMAGE_ID: "nav-traffic-light",
  loadTrafficLightImage: (m: {
    hasImage: (i: string) => boolean;
    addImage: (i: string) => void;
  }) => {
    if (!m.hasImage("nav-traffic-light")) m.addImage("nav-traffic-light");
  },
}));

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
  progress: { alongMeters: 100, speedMps: 10 },
  routeProvider: "routing-valhalla",
  fasterRoute: null,
  mode: "driving",
  selectRoute: vi.fn(),
};

vi.mock("@openmapx/core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useNavigationStore: Object.assign(
    (selector: (s: typeof navState) => unknown) => selector(navState),
    { getState: () => navState },
  ),
  useRouteFlow: () => ({
    r0: [{ startMeters: 200, endMeters: 900, los: "queuing", confidence: "measured" }],
  }),
}));
vi.mock("@/lib/useDrawnDirectionsRoutes", () => ({
  useDrawnDirectionsRoutes: () => ({
    routes: [],
    activeRouteIndex: 0,
    provider: "routing-valhalla",
    mode: "driving",
    isEvMode: false,
    evStops: [],
    navigating: true,
  }),
}));

import { NavigationRouteLayer } from "./NavigationRouteLayer";
import { NavTrafficSignalsLayer } from "./NavTrafficSignalsLayer";
import { RouteTrafficLayer } from "./RouteTrafficLayer";

/**
 * Mount the `nav-top` layer FIRST. That is the order that used to strand the
 * route line above the basemap labels: `resolveBeforeId` anchored a below-labels
 * layer to the only registered layer ranked above it, which was itself above the
 * labels. The per-file layer tests each render one component against their own
 * map, so none of them can see this.
 */
function NavigationStack() {
  return (
    <>
      <NavTrafficSignalsLayer />
      <RouteTrafficLayer />
      <NavigationRouteLayer />
    </>
  );
}

const ids = () => [...fake.state.layers.keys()];
const aboveLabels = (all: string[]) => all.slice(all.indexOf("place-labels") + 1);

describe("layer groups from several components on one map", () => {
  it("straddles the basemap labels correctly whatever order the components mount in", () => {
    render(<NavigationStack />);

    // Everything the navigation stack draws belongs under the labels except the
    // traffic-signal icons, which are the one `nav-top` layer.
    expect(aboveLabels(ids())).toEqual(["nav-traffic-signals"]);
    expect(ids()).toEqual([
      "water",
      "nav-route-alts",
      "route-traffic-alt",
      "nav-route-proposed",
      "nav-route-remaining-casing",
      "nav-route-traveled",
      "nav-route-remaining",
      "route-traffic-active",
      "route-traffic-current",
      "place-labels",
      "nav-traffic-signals",
    ]);
  });

  it("comes back in the same order, with its data, after a style change", () => {
    render(<NavigationStack />);
    const before = ids();

    act(() => {
      fake.map.setStyle({} as never);
    });

    expect(ids()).toEqual(before);
    expect(aboveLabels(ids())).toEqual(["nav-traffic-signals"]);
    const navData = fake.state.sources.get("nav-route-source")?.data as { features: unknown[] };
    expect(navData.features.length).toBeGreaterThan(0);
  });
});

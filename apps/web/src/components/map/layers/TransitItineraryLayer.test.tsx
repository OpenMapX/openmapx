import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, createFakeMap, type FakeMap, render } from "@/test";

const state = vi.hoisted(() => {
  const walk = {
    mode: "walking",
    from: { name: "Home", lat: 50, lng: 8 },
    to: { name: "Main St", lat: 50.01, lng: 8.01 },
    geometry: {
      type: "LineString",
      coordinates: [
        [8, 50],
        [8.01, 50.01],
      ],
    },
  };
  const bus = {
    mode: "bus",
    route: { color: "#ff0000" },
    from: { name: "Main St", lat: 50.01, lng: 8.01 },
    to: { name: "Station", lat: 50.1, lng: 8.1 },
    geometry: {
      type: "LineString",
      coordinates: [
        [8.01, 50.01],
        [8.1, 50.1],
      ],
    },
  };
  return {
    fitBounds: vi.fn(),
    directions: {
      mode: "transit",
      transitItineraries: [{ legs: [walk, bus] }],
      activeItineraryIndex: 0,
    },
    navigation: { status: "idle", kind: "transit", transitProgress: null as null | object },
  };
});
let fake: FakeMap;
const mapRef = {
  get current() {
    return fake.map;
  },
};
vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ mapRef, mapReady: true, styleVersion: 0, fitBounds: state.fitBounds }),
}));
vi.mock("@/integration-api/overlay/useRenderedMapAttributions", () => ({
  useRenderedMapAttributions: () => {},
}));
vi.mock("@openmapx/core", () => ({
  API_ENDPOINTS: { transitLegGeometry: "/leg-geometry" },
  apiClient: { get: vi.fn() },
  MODE_COLORS: { walking: "#757575" },
  routeColor: (route: { color?: string }, fallback: string) => route.color ?? fallback,
  useDirectionsStore: () => state.directions,
  useNavigationStore: (selector: (s: unknown) => unknown) => selector(state.navigation),
}));

import { TransitItineraryLayer } from "./TransitItineraryLayer";

const LAYERS = [
  "transit-itinerary-casing",
  "transit-itinerary-walk",
  "transit-itinerary-transit",
  "transit-itinerary-points",
];

function features(source: string): unknown[] {
  return (fake.state.sources.get(source)?.data as { features?: unknown[] })?.features ?? [];
}

beforeEach(() => {
  fake = createFakeMap({ styleLoaded: true });
  state.fitBounds.mockClear();
  state.navigation = { status: "idle", kind: "transit", transitProgress: null };
});

describe("TransitItineraryLayer", () => {
  it("draws the selected itinerary and fits it once", () => {
    const { rerender } = render(<TransitItineraryLayer />);

    for (const layer of LAYERS) expect(fake.state.layers.has(layer)).toBe(true);
    expect(features("transit-itinerary-source")).toHaveLength(2);
    expect(features("transit-itinerary-points-source")).toHaveLength(3);
    expect(state.fitBounds).toHaveBeenCalledTimes(1);
    expect(state.fitBounds).toHaveBeenCalledWith(
      [
        [8, 50],
        [8.1, 50.1],
      ],
      80,
    );

    state.navigation = {
      status: "navigating",
      kind: "transit",
      transitProgress: { currentLegIndex: 1 },
    };
    rerender(<TransitItineraryLayer />);
    expect(state.fitBounds).toHaveBeenCalledTimes(1);
  });

  it("redraws the itinerary with its data after a style rebuild", () => {
    render(<TransitItineraryLayer />);
    act(() => fake.map.setStyle({} as never));

    for (const layer of LAYERS) expect(fake.state.layers.has(layer)).toBe(true);
    expect(features("transit-itinerary-source")).toHaveLength(2);
    expect(features("transit-itinerary-points-source")).toHaveLength(3);
    expect(state.fitBounds).toHaveBeenCalledTimes(1);
  });

  it("removes its layers and sources when the itinerary is cleared", () => {
    const { rerender } = render(<TransitItineraryLayer />);
    state.directions = { ...state.directions, mode: "driving" };
    rerender(<TransitItineraryLayer />);
    state.directions = { ...state.directions, mode: "transit" };

    for (const layer of LAYERS) expect(fake.state.layers.has(layer)).toBe(false);
    expect(fake.state.sources.has("transit-itinerary-source")).toBe(false);
    expect(fake.state.sources.has("transit-itinerary-points-source")).toBe(false);
  });
});

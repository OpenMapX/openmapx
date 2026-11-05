import { waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRenderedMapAttributions } from "@/integration-api/overlay/useRenderedMapAttributions";
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
    get: vi.fn(),
    fitBounds: vi.fn(),
    directions: {
      mode: "transit",
      transitItineraries: [{ legs: [walk, bus] }],
      activeItineraryIndex: 0,
    },
    navigation: {
      status: "idle",
      kind: "transit",
      transitProgress: null as null | object,
      itinerary: null as null | { legs: (typeof walk)[] },
    },
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
  useRenderedMapAttributions: vi.fn(),
}));
vi.mock("@openmapx/core", () => ({
  API_ENDPOINTS: { transitLegGeometry: "/leg-geometry" },
  apiClient: { get: state.get },
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

const preview = structuredClone(state.directions);
beforeEach(() => {
  state.directions = structuredClone(preview);
  state.get.mockReset();
  fake = createFakeMap({ styleLoaded: true });
  state.fitBounds.mockClear();
  state.navigation = { status: "idle", kind: "transit", transitProgress: null, itinerary: null };
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
      itinerary: state.directions.transitItineraries[0],
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

it("draws the restored native walking leg instead of the old directions preview", () => {
  const restored = structuredClone(state.directions.transitItineraries[0]);
  restored.legs[0].geometry.coordinates = [
    [9, 51],
    [9.01, 51.01],
  ];
  state.navigation = {
    status: "navigating",
    kind: "transit",
    itinerary: restored,
    transitProgress: {
      currentLegIndex: 0,
      fractionAlongLeg: 0.25,
      confidence: "gps",
      deviationMeters: 0,
    },
  };
  render(<TransitItineraryLayer />);
  expect(features("transit-nav-walk-source")).toMatchObject([
    {
      geometry: {
        coordinates: [
          [9, 51],
          [9.01, 51.01],
        ],
      },
    },
  ]);
  expect(state.fitBounds).not.toHaveBeenCalled();
});
it("changes walking progress paint without replacing its geometry and removes it at boarding", () => {
  const itinerary = state.directions.transitItineraries[0];
  state.navigation = {
    status: "navigating",
    kind: "transit",
    itinerary,
    transitProgress: {
      currentLegIndex: 0,
      fractionAlongLeg: 0.1,
      confidence: "gps",
      deviationMeters: 0,
    },
  };
  const view = render(<TransitItineraryLayer />);
  const source = fake.state.sources.get("transit-nav-walk-source");
  expect(source?.lineMetrics).toBe(true);
  const paint = fake.state.paint.get("transit-nav-walk-remaining")?.["line-gradient"];
  state.navigation = {
    ...state.navigation,
    transitProgress: {
      currentLegIndex: 0,
      fractionAlongLeg: 0.6,
      confidence: "gps",
      deviationMeters: 0,
    },
  };
  view.rerender(<TransitItineraryLayer />);
  expect(fake.state.sources.get("transit-nav-walk-source")).toBe(source);
  expect(fake.state.counts.setData.get("transit-nav-walk-source") ?? 0).toBe(0);
  expect(fake.state.paint.get("transit-nav-walk-remaining")?.["line-gradient"]).not.toEqual(paint);
  act(() => fake.map.setStyle({} as never));
  expect(fake.state.layers.has("transit-nav-walk-remaining")).toBe(true);
  state.navigation = {
    ...state.navigation,
    transitProgress: { currentLegIndex: 1, phase: "waiting-to-board" },
  };
  view.rerender(<TransitItineraryLayer />);
  expect(fake.state.layers.has("transit-nav-walk-remaining")).toBe(false);
  expect(fake.state.sources.has("transit-nav-walk-source")).toBe(false);
});

it("retains walked progress across an equivalent uncertain full snapshot and resets for repair", () => {
  const itinerary = structuredClone(state.directions.transitItineraries[0]);
  state.navigation = {
    status: "navigating",
    kind: "transit",
    itinerary,
    transitProgress: {
      currentLegIndex: 0,
      fractionAlongLeg: 0.6,
      confidence: "gps",
      deviationMeters: 0,
    },
  };
  const view = render(<TransitItineraryLayer />);
  const gradient = () => fake.state.paint.get("transit-nav-walk-remaining")?.["line-gradient"];
  const trusted = gradient();
  state.navigation = {
    ...state.navigation,
    itinerary: structuredClone(itinerary),
    transitProgress: {
      currentLegIndex: 0,
      fractionAlongLeg: 0.9,
      confidence: "uncertain",
      deviationMeters: 70,
    },
  };
  view.rerender(<TransitItineraryLayer />);
  expect(gradient()).toEqual(trusted);
  const repaired = structuredClone(itinerary);
  repaired.legs[0].geometry.coordinates.splice(1, 0, [8.02, 50]);
  state.navigation = { ...state.navigation, itinerary: repaired };
  view.rerender(<TransitItineraryLayer />);
  expect(gradient()).toEqual([
    "step",
    ["line-progress"],
    expect.any(String),
    0,
    expect.any(String),
  ]);
});

it("keeps the preview fallback and stop point when a walk has no drawable line", () => {
  const itinerary = structuredClone(state.directions.transitItineraries[0]);
  itinerary.legs[0].geometry.coordinates = [[8, 50]];
  state.navigation = {
    status: "navigating",
    kind: "transit",
    itinerary,
    transitProgress: { currentLegIndex: 0 },
  };
  render(<TransitItineraryLayer />);
  expect(fake.state.layers.has("transit-nav-walk-remaining")).toBe(false);
  expect(fake.state.layers.get("transit-itinerary-walk")?.filter).toEqual([
    "==",
    ["get", "isStreet"],
    true,
  ]);
  expect(features("transit-itinerary-points-source")).toHaveLength(3);
});

it("refines and credits a native-restored trip without a directions preview", async () => {
  const bus = { ...state.directions.transitItineraries[0].legs[1], tripId: "restored-bus" };
  const restored = { legs: [bus] };
  state.get.mockResolvedValue({
    data: {
      type: "LineString",
      coordinates: [
        [8, 50],
        [8.05, 50.2],
        [8.1, 50.1],
      ],
    },
  });
  state.directions = { ...state.directions, mode: "driving", transitItineraries: [] };
  state.navigation = {
    status: "navigating",
    kind: "transit",
    itinerary: restored,
    transitProgress: { currentLegIndex: 0 },
  };
  const view = render(<TransitItineraryLayer />);
  await waitFor(() =>
    expect(features("transit-itinerary-source")).toMatchObject([
      {
        geometry: {
          coordinates: [
            [8, 50],
            [8.05, 50.2],
            [8.1, 50.1],
          ],
        },
      },
    ]),
  );
  expect(useRenderedMapAttributions).toHaveBeenCalledWith(
    "transit-itinerary",
    expect.any(Array),
    true,
  );
  expect(state.fitBounds).not.toHaveBeenCalled();
  state.navigation = { ...state.navigation, itinerary: structuredClone(restored) };
  view.rerender(<TransitItineraryLayer />);
  expect(state.get).toHaveBeenCalledTimes(1);
});

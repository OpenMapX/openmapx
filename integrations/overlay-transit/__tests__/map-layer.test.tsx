import { useDirectionsStore } from "@openmapx/core";
import type { TransitItinerary } from "@openmapx/mobility-core/transit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createFakeMap, type FakeMap, render } from "@/test";
import { useTransitStore } from "../store";

let fake: FakeMap;
const MAP_REF = {
  get current() {
    return fake.map;
  },
};

vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({
    mapRef: MAP_REF,
    mapReady: true,
    styleVersion: 0,
  }),
}));

vi.mock("@/integration-api/overlay/useMapAttributions", () => ({
  useMapAttributions: () => undefined,
}));

import { networkRouteFeatures, TransitLayer } from "../map-layer";

const SOURCE_ID = "openmapx-transit-motis-source";
const MOTIS_LINE_ID = "openmapx-transit-motis-line";
const ITINERARY = {
  legs: [{ mode: "tram" }],
} as unknown as TransitItinerary;
const STALE_DATA: GeoJSON.FeatureCollection = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: [
          [8, 50],
          [8.1, 50.1],
        ],
      },
      properties: { routeId: "stale" },
    },
  ],
};

beforeEach(() => {
  vi.useFakeTimers();
  fake = createFakeMap({ styleLoaded: true, zoom: 12 });
  useTransitStore.setState({ panelOpen: true, layerVisible: true });
});

afterEach(() => {
  useTransitStore.setState({ panelOpen: false, layerVisible: false });
  useDirectionsStore.setState({ mode: "driving", transitItineraries: [], activeItineraryIndex: 0 });
  vi.useRealTimers();
});

describe("TransitLayer", () => {
  it("clears mounted MOTIS data when hidden instead of exposing it on re-show", () => {
    render(<TransitLayer />);
    const source = fake.state.sources.get(SOURCE_ID);
    expect(source).toBeDefined();
    (source?.setData as (data: GeoJSON.FeatureCollection) => void)(STALE_DATA);

    act(() => {
      useTransitStore.setState({ panelOpen: false, layerVisible: false });
    });
    expect(fake.state.sources.has(SOURCE_ID)).toBe(false);
    expect(fake.state.layers.has(MOTIS_LINE_ID)).toBe(false);

    act(() => {
      useTransitStore.setState({ panelOpen: true, layerVisible: true });
    });
    expect(fake.state.sources.get(SOURCE_ID)?.data).toEqual({
      type: "FeatureCollection",
      features: [],
    });
  });

  it("keeps the receded network across a style rebuild", () => {
    useDirectionsStore.setState({
      mode: "transit",
      transitItineraries: [ITINERARY],
      activeItineraryIndex: 0,
    });
    render(<TransitLayer />);
    expect(fake.state.paint.get(MOTIS_LINE_ID)?.["line-opacity"]).toBe(0.25);

    act(() => {
      fake.map.setStyle({});
    });
    expect(fake.state.paint.get(MOTIS_LINE_ID)?.["line-opacity"]).toBe(0.25);
  });

  it("recedes the operated network while a chosen itinerary is on the map", () => {
    render(<TransitLayer />);
    expect(fake.state.paint.get(MOTIS_LINE_ID)?.["line-opacity"]).toBe(0.9);

    act(() => {
      useDirectionsStore.setState({
        mode: "transit",
        transitItineraries: [ITINERARY],
        activeItineraryIndex: 0,
      });
    });
    expect(fake.state.paint.get(MOTIS_LINE_ID)?.["line-opacity"]).toBe(0.25);

    act(() => {
      useDirectionsStore.setState({ transitItineraries: [] });
    });
    expect(fake.state.paint.get(MOTIS_LINE_ID)?.["line-opacity"]).toBe(0.9);
  });
});

it("narrows network feature credits to drawable route snapshots", () => {
  const a = { sourceId: "a", name: "A" };
  const b = { sourceId: "b", name: "B" };
  const features = networkRouteFeatures([
    {
      id: "a",
      contributors: [a],
      shortName: "A",
      longName: "",
      mode: "rail",
      operatorName: "",
      geometry: {
        type: "LineString",
        coordinates: [
          [8, 50],
          [8.1, 50.1],
        ],
      },
    },
    { id: "b", contributors: [b], shortName: "B", longName: "", mode: "rail", operatorName: "" },
  ]);
  expect(features).toHaveLength(1);
  expect(JSON.parse(String(features[0].properties?._mapAttributions))).toEqual([a]);
});

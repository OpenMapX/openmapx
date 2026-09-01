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

import { TransitLayer } from "../map-layer";

const SOURCE_ID = "openmapx-transit-motis-source";
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

    expect(fake.state.sources.get(SOURCE_ID)?.data).toEqual({
      type: "FeatureCollection",
      features: [],
    });
  });
});

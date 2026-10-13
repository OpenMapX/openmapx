import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeMap, type FakeMap, render } from "@/test";

const state = vi.hoisted(() => ({
  a: { sourceId: "a", name: "Timetable A" },
  b: { sourceId: "b", name: "GPS B" },
  c: { sourceId: "c", name: "Infrastructure C" },
}));
let fake: FakeMap;
const mapRef = {
  get current() {
    return fake.map;
  },
};
vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ mapRef, mapReady: true, styleVersion: 0, fitBounds: vi.fn(), flyTo: vi.fn() }),
}));
vi.mock("@openmapx/core", () => ({
  routeColor: () => "#0055aa",
  usePlaceStore: Object.assign((selector?: (s: unknown) => unknown) => {
    const s = {
      selectedPlace: { id: "stop", rawCategory: "transit_stop" },
      activeRouteId: "route",
      transitMapFocus: null,
    };
    return selector ? selector(s) : s;
  }, {}),
  useTransitRoute: () => ({
    data: {
      contributors: [state.a],
      geometry: {
        type: "LineString",
        coordinates: [
          [8, 50],
          [8.1, 50.1],
        ],
      },
    },
  }),
  useRouteStops: () => ({
    data: [{ id: "stop", name: "Stop", lat: 50, lng: 8, contributors: [state.a] }],
  }),
  useRouteLive: () => ({
    data: { vehicles: [{ id: "vehicle", lat: 50, lng: 8, contributors: [state.b] }] },
  }),
  usePlaceStopInfrastructure: () => ({
    data: {
      stopId: "stop",
      contributors: [state.c],
      platforms: [{ id: "platform", lat: 50, lng: 8, publicCode: "1", contributors: [state.c] }],
      parking: [],
      geometry: {},
    },
  }),
}));

import { SelectedStopInfrastructureLayer } from "./SelectedStopInfrastructureLayer";
import { TransitRouteLayer } from "./TransitRouteLayer";
import { VehicleLiveLayer } from "./VehicleLiveLayer";

beforeEach(() => {
  fake = createFakeMap({ styleLoaded: true, zoom: 16 });
});
function features(source: string): Array<{ properties?: { _mapAttributions?: string } }> {
  return ((fake.state.sources.get(source)?.data as { features?: unknown[] })?.features ??
    []) as Array<{ properties?: { _mapAttributions?: string } }>;
}
describe("core transit map acquisition receipts", () => {
  it("keeps independently fetched vehicle and infrastructure snapshots on their actual features", () => {
    render(
      <>
        <TransitRouteLayer />
        <VehicleLiveLayer />
        <SelectedStopInfrastructureLayer />
      </>,
    );
    expect(
      JSON.parse(features("vehicle-live-source")[0].properties?._mapAttributions ?? "[]"),
    ).toEqual([state.b, state.a]);
    expect(
      JSON.parse(features("selected-stop-platform-source")[0].properties?._mapAttributions ?? "[]"),
    ).toEqual([state.c]);
    expect(
      JSON.parse(
        features("transit-route-detail-stops-source")[0].properties?._mapAttributions ?? "[]",
      ),
    ).toEqual([state.a]);
  });
});

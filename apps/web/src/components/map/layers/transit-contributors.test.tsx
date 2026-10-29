import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, createFakeMap, type FakeMap, render } from "@/test";

const state = vi.hoisted(() => {
  const a = { sourceId: "a", name: "Timetable A" };
  const b = { sourceId: "b", name: "GPS B" };
  const c = { sourceId: "c", name: "Infrastructure C" };
  return {
    a,
    b,
    c,
    route: {
      contributors: [a],
      geometry: {
        type: "LineString",
        coordinates: [
          [8, 50],
          [8.1, 50.1],
        ],
      },
    },
    stops: [{ id: "stop", name: "Stop", lat: 50, lng: 8, contributors: [a] }],
    live: { vehicles: [{ id: "vehicle", lat: 50, lng: 8, contributors: [b] }] },
    infrastructure: {
      stopId: "stop",
      contributors: [c],
      platforms: [{ id: "platform", lat: 50, lng: 8, publicCode: "1", contributors: [c] }],
      parking: [],
      geometry: {},
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
  useTransitRoute: () => ({ data: state.route }),
  useRouteStops: () => ({ data: state.stops }),
  useRouteLive: () => ({ data: state.live }),
  usePlaceStopInfrastructure: () => ({ data: state.infrastructure }),
}));

import { SelectedStopInfrastructureLayer } from "./SelectedStopInfrastructureLayer";
import { TransitRouteLayer } from "./TransitRouteLayer";
import { VehicleLiveLayer } from "./VehicleLiveLayer";

function Layers() {
  return (
    <>
      <TransitRouteLayer />
      <VehicleLiveLayer />
      <SelectedStopInfrastructureLayer />
    </>
  );
}

beforeEach(() => {
  fake = createFakeMap({ styleLoaded: true, zoom: 16 });
  state.live = { vehicles: [{ id: "vehicle", lat: 50, lng: 8, contributors: [state.b] }] };
});
function features(source: string): Array<{
  properties?: { _mapAttributions?: string };
  geometry?: { coordinates?: unknown };
}> {
  return ((fake.state.sources.get(source)?.data as { features?: unknown[] })?.features ??
    []) as Array<{ properties?: { _mapAttributions?: string } }>;
}
describe("core transit map acquisition receipts", () => {
  it("keeps independently fetched vehicle and infrastructure snapshots on their actual features", () => {
    render(<Layers />);
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

  it("moves a vehicle in place instead of re-adding its layer", () => {
    const { rerender } = render(<Layers />);
    const added = fake.state.counts.addLayer.get("vehicle-live-layer");
    expect(added).toBe(1);

    state.live = { vehicles: [{ id: "vehicle", lat: 50.01, lng: 8.01, contributors: [state.b] }] };
    rerender(<Layers />);

    expect(fake.state.counts.addLayer.get("vehicle-live-layer")).toBe(added);
    expect(fake.state.counts.removeLayer.get("vehicle-live-layer")).toBeUndefined();
    expect(features("vehicle-live-source")[0].geometry?.coordinates).toEqual([8.01, 50.01]);
  });

  it("redraws every transit layer with its data after a style rebuild", () => {
    render(<Layers />);
    act(() => fake.map.setStyle({} as never));

    for (const layer of [
      "transit-route-detail-line",
      "transit-route-detail-stops",
      "transit-route-detail-current-stop",
      "vehicle-live-layer",
      "selected-stop-platforms",
      "selected-stop-platform-labels",
    ]) {
      expect(fake.state.layers.has(layer)).toBe(true);
    }
    expect(fake.state.sources.get("transit-route-detail-source")?.data).toMatchObject({
      geometry: { type: "LineString" },
    });
    expect(features("transit-route-detail-stops-source")).toHaveLength(1);
    expect(features("vehicle-live-source")).toHaveLength(1);
    expect(features("selected-stop-platform-source")).toHaveLength(1);
  });
});

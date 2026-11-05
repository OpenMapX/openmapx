import { useNavigationStore } from "@openmapx/core";
import type { TripItinerary } from "@openmapx/mobility-core/transit";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, createFakeMap, type FakeMap, render } from "@/test";
import { LiveTransitLayer } from "../map-layer";
import { useLiveTransitStore } from "../store";
import type { LiveTransitSnapshot } from "../types";

let fake: FakeMap;
let styleVersion = 0;
const mapRef = {
  get current() {
    return fake.map;
  },
};
vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ mapRef, mapReady: true, styleVersion }),
}));
vi.mock("@/integration-api/runtime/EnvProvider", () => ({
  useOptionalEnv: () => ({ apiUrl: "https://api.test" }),

  useEnv: () => ({ apiUrl: "https://api.test" }),
}));
vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

const SOURCE = "live-transit-source";
const ICON = "live-transit-icon";
const RING = "live-transit-onroute-ring";
const NOW = "2026-10-16T12:00:00Z";
const receipt = { sourceId: "observed-feed", name: "Captured vehicle supplier" };
const snapshot: LiveTransitSnapshot = {
  vehicles: [
    {
      id: "bus-42",
      provider: "observed-feed",
      sourceId: "observed-feed",
      tripId: "trip-current",
      mode: "bus",
      displayLabel: "42",
      lat: 50,
      lng: 6,
      bearing: 90,
      updatedAt: NOW,
      positionKind: "observed",
      contributors: [receipt],
    },
  ],
  alerts: [],
};
function itinerary(tripId: string): TripItinerary {
  return {
    duration: 600,
    startTime: NOW,
    endTime: "2026-10-16T12:10:00Z",
    transfers: 0,
    walkDistance: 0,
    legs: [
      {
        tripId,
        mode: "bus",
        startTime: NOW,
        endTime: "2026-10-16T12:10:00Z",
        from: { name: "Start", lat: 50, lng: 6 },
        to: { name: "End", lat: 50.1, lng: 6.1 },
        geometry: {
          type: "LineString",
          coordinates: [
            [6, 50],
            [6.1, 50.1],
          ],
        },
      },
    ],
  };
}
function vehicleData() {
  return fake.state.sources.get(SOURCE)?.data as GeoJSON.FeatureCollection | undefined;
}
function delegatedClickCount() {
  return fake.state.listenerCalls
    .filter((call) => call.event === "click" && call.layerId === ICON)
    .reduce((active, call) => active + (call.method === "off" ? -1 : 1), 0);
}
function expectRetainedVehicle() {
  expect(vehicleData()?.features).toHaveLength(1);
  expect(vehicleData()?.features[0]).toMatchObject({
    id: "bus-42",
    geometry: { type: "Point", coordinates: [6, 50] },
    properties: { id: "bus-42", tripId: "trip-current", displayLabel: "42" },
  });
  expect(JSON.parse(String(vehicleData()?.features[0].properties?._mapAttributions))).toEqual([
    receipt,
  ]);
  expect(fake.map.getFilter(RING)).toEqual([
    "in",
    ["get", "tripId"],
    ["literal", ["trip-current"]],
  ]);
  expect(delegatedClickCount()).toBe(1);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  styleVersion = 0;
  fake = createFakeMap({ zoom: 12 });
  useLiveTransitStore.setState({
    layerVisible: true,
    excludedProviders: new Set(),
    excludedModes: new Set(),
    excludedCodespaces: new Set(),
  });
  useNavigationStore.setState({
    kind: "transit",
    status: "navigating",
    itinerary: itinerary("trip-obsolete"),
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => snapshot })),
  );
});
afterEach(() => {
  act(() => {
    useLiveTransitStore.setState({ layerVisible: false });
    useNavigationStore.setState({ kind: "ground", status: "idle", itinerary: null });
  });
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it.each(["hide", "unmount"] as const)(
  "retains vehicles and the current itinerary across a pending-source style replacement, then cleans up on %s",
  async (teardown) => {
    const view = render(<LiveTransitLayer />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(vehicleData()?.features).toHaveLength(1);
    act(() => useNavigationStore.setState({ itinerary: itinerary("trip-current") }));
    expectRetainedVehicle();
    const oldSource = fake.map.getSource(SOURCE);

    // MapLibre can publish the new parsed style before its sources settle.
    fake.state.styleLoaded = false;
    act(() => {
      fake.map.setStyle({ version: 8, sources: {}, layers: [] });
    });
    expect(fake.map.isStyleLoaded()).toBe(false);
    expect(fake.map.getSource(SOURCE)).not.toBe(oldSource);
    expectRetainedVehicle();

    // The host also invalidates style-bound React effects after the style event.
    styleVersion++;
    view.rerender(<LiveTransitLayer />);
    expectRetainedVehicle();
    const source = fake.map.getSource(SOURCE);
    const setDataCount = fake.state.counts.setData.get(SOURCE);
    const addLayerCount = fake.state.counts.addLayer.get(ICON);
    act(() => {
      for (let i = 0; i < 10; i++) fake.emit("styledata");
    });
    expectRetainedVehicle();
    expect(fake.map.getSource(SOURCE)).toBe(source);
    expect(fake.state.counts.setData.get(SOURCE)).toBe(setDataCount);
    expect(fake.state.counts.addLayer.get(ICON)).toBe(addLayerCount);

    if (teardown === "hide") act(() => useLiveTransitStore.setState({ layerVisible: false }));
    else view.unmount();
    expect(fake.map.getSource(SOURCE)).toBeUndefined();
    expect(fake.map.getLayer(ICON)).toBeUndefined();
    expect(fake.map.getLayer(RING)).toBeUndefined();
    expect(delegatedClickCount()).toBe(0);
    act(() => {
      fake.emit("idle");
      fake.emit("styledata");
      fake.emit("render");
    });
    expect(fake.map.getSource(SOURCE)).toBeUndefined();
    expect(fake.map.getLayer(ICON)).toBeUndefined();
    expect(delegatedClickCount()).toBe(0);
    view.unmount();
  },
);

it("republishes the full vehicle collection into a rebuilt source before diffing again", async () => {
  const diffs: Array<{ source: unknown; diff: { update?: Array<{ id: unknown }> } }> = [];
  const addSource = fake.map.addSource.bind(fake.map);
  vi.spyOn(fake.map, "addSource").mockImplementation((id, spec) => {
    addSource(id, spec);
    const source = fake.state.sources.get(id) as Record<string, unknown> | undefined;
    if (id === SOURCE && source) {
      source.updateData = (diff: { update?: Array<{ id: unknown }> }) => {
        diffs.push({ source, diff });
      };
    }
    return fake.map;
  });
  let current = snapshot;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => current })),
  );
  const relabel = (displayLabel: string): LiveTransitSnapshot => ({
    ...snapshot,
    vehicles: snapshot.vehicles.map((vehicle) => ({ ...vehicle, displayLabel })),
  });
  const poll = async () => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
  };

  const view = render(<LiveTransitLayer />);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  current = relabel("42A");
  await poll();
  expect(diffs).toHaveLength(1);
  expect(diffs[0].source).toBe(fake.map.getSource(SOURCE));

  act(() => {
    fake.map.setStyle({ version: 8, sources: {}, layers: [] });
  });
  const rebuilt = fake.map.getSource(SOURCE);
  expect(rebuilt).not.toBe(diffs[0].source);
  expect(vehicleData()?.features).toHaveLength(1);
  expect(vehicleData()?.features[0].properties).toMatchObject({ displayLabel: "42A" });
  expect(diffs).toHaveLength(1);

  current = relabel("42B");
  await poll();
  expect(diffs).toHaveLength(2);
  expect(diffs[1].source).toBe(rebuilt);
  expect(diffs[1].diff.update?.map((entry) => entry.id)).toEqual(["bus-42"]);
  view.unmount();
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createFakeMap, createQueryWrapper, type FakeMap, render } from "@/test";

let fake: FakeMap;
const mapRef = {
  get current() {
    return fake.map;
  },
};
vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ mapRef, mapReady: true, styleVersion: 0 }),
}));
vi.mock("@/integration-api/runtime/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: "https://api.test" }),
}));
vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

import { NauticalLayer } from "../map-layer";
import { useNauticalStore } from "../store";

const NOAA_LAYER = "openmapx-nautical-noaa-layer";
const KARTVERKET_LAYER = "openmapx-nautical-kartverket-layer";
const NORTH_SEA = { west: 2, south: 52, east: 4, north: 54 };
const CHESAPEAKE = { west: -77, south: 37, east: -76, north: 39 };
const OSLOFJORD = { west: 10, south: 59, east: 11, north: 60 };

let bounds: { west: number; south: number; east: number; north: number };

function panTo(next: typeof bounds) {
  Object.assign(bounds, next);
  act(() => fake.emit("moveend"));
}

beforeEach(() => {
  bounds = { ...NORTH_SEA };
  fake = createFakeMap({ bounds });
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise(() => {})),
  );
  useNauticalStore.setState({
    panelOpen: true,
    layerVisible: true,
    showNoaaCharts: true,
    showSeamarks: false,
    showDepth: false,
    showHarbors: false,
    showTideStations: false,
  });
});

afterEach(() => {
  useNauticalStore.setState({ panelOpen: false, layerVisible: false });
  vi.unstubAllGlobals();
});

describe("nautical chart coverage", () => {
  it("follows the viewport into and out of each provider's waters", () => {
    const view = render(<NauticalLayer />, { wrapper: createQueryWrapper() });
    expect(fake.map.getLayer(NOAA_LAYER)).toBeUndefined();
    expect(fake.map.getLayer(KARTVERKET_LAYER)).toBeUndefined();

    panTo(CHESAPEAKE);
    expect(fake.map.getLayer(NOAA_LAYER)).toBeDefined();
    expect(fake.map.getLayer(KARTVERKET_LAYER)).toBeUndefined();

    panTo(OSLOFJORD);
    expect(fake.map.getLayer(NOAA_LAYER)).toBeUndefined();
    expect(fake.map.getLayer(KARTVERKET_LAYER)).toBeDefined();

    view.unmount();
    expect(fake.map.getLayer(KARTVERKET_LAYER)).toBeUndefined();
    expect(fake.state.sources.size).toBe(0);
  });

  it("stops following the viewport once charts are switched off", () => {
    const view = render(<NauticalLayer />, { wrapper: createQueryWrapper() });
    act(() => useNauticalStore.setState({ showNoaaCharts: false }));
    panTo(CHESAPEAKE);
    expect(fake.map.getLayer(NOAA_LAYER)).toBeUndefined();
    view.unmount();
  });
});

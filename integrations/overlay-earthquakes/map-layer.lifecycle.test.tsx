import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createFakeMap, type FakeMap, render } from "@/test";
import { useEarthquakeStore } from "./store";

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

const { EarthquakeLayer } = await import("./map-layer");

const HEATMAP_LAYER_ID = "openmapx-earthquakes-heatmap";
const CIRCLE_LAYER_ID = "openmapx-earthquakes-circles";
const PULSE_LAYER_ID = "openmapx-earthquakes-pulse";

beforeEach(() => {
  vi.useFakeTimers();
  fake = createFakeMap();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise(() => {})),
  );
  useEarthquakeStore.setState({ layerVisible: true, showHeatmap: true, colorMode: "depth" });
});

afterEach(() => {
  act(() => useEarthquakeStore.setState({ layerVisible: false, showHeatmap: false }));
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("EarthquakeLayer lifecycle", () => {
  it("installs the heatmap once a stylesheet still parsing at show time is ready", () => {
    const style = fake.map.getStyle();
    let parsed = false;
    vi.spyOn(fake.map, "getStyle").mockImplementation(() =>
      parsed ? style : (undefined as never),
    );
    const view = render(<EarthquakeLayer />);
    expect(fake.map.getLayer(HEATMAP_LAYER_ID)).toBeUndefined();

    parsed = true;
    act(() => {
      fake.emit("styledata");
      fake.emit("style.load");
    });
    expect(fake.map.getLayer(HEATMAP_LAYER_ID)).toBeDefined();
    view.unmount();
  });

  it("toggles the heatmap and recolours the circles without leaving stale layers", () => {
    const view = render(<EarthquakeLayer />);
    expect(fake.map.getLayer(HEATMAP_LAYER_ID)).toBeDefined();

    act(() => useEarthquakeStore.setState({ showHeatmap: false, colorMode: "recency" }));
    expect(fake.map.getLayer(HEATMAP_LAYER_ID)).toBeUndefined();
    expect(JSON.stringify(fake.state.paint.get(CIRCLE_LAYER_ID)?.["circle-color"])).toContain(
      "ageMs",
    );

    act(() => useEarthquakeStore.setState({ layerVisible: false }));
    expect(fake.map.getLayer(CIRCLE_LAYER_ID)).toBeUndefined();
    expect(fake.map.getLayer(PULSE_LAYER_ID)).toBeUndefined();
    view.unmount();
  });

  it("keeps the pulse animating after a style rebuild", () => {
    const view = render(<EarthquakeLayer />);
    act(() => {
      fake.map.setStyle({} as never);
    });
    expect(fake.map.getLayer(PULSE_LAYER_ID)).toBeDefined();

    const before = fake.state.counts.setPaintPropertyByName.get(
      `${PULSE_LAYER_ID}:circle-stroke-opacity`,
    );
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(
      fake.state.counts.setPaintPropertyByName.get(`${PULSE_LAYER_ID}:circle-stroke-opacity`) ?? 0,
    ).toBeGreaterThan(before ?? 0);
    view.unmount();
  });
});

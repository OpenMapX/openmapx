import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { layerRegistrations } from "@/components/map/layers/layerStack";
import { act, createFakeMap, type FakeMap, render } from "@/test";
import { useSunTimeStore } from "../store";

let fake: FakeMap;

vi.mock("@/lib/MapContext", () => ({
  useMap: () => ({
    mapRef: { current: fake.map },
    mapReady: true,
    styleVersion: 0,
  }),
}));

import SunTimeLayer from "../map-layer";

const SOURCE_ID = "sun-time-terminator";
const BAND_LAYER_IDS = Array.from({ length: 16 }, (_, i) => `sun-time-band-${i}`);

beforeEach(() => {
  fake = createFakeMap();
  useSunTimeStore.setState({
    layerVisible: true,
    showTerminator: true,
    timeMs: 1_700_000_000_000,
  });
});

afterEach(() => {
  useSunTimeStore.setState({ layerVisible: false, timeMs: null });
  vi.useRealTimers();
});

describe("SunTimeLayer", () => {
  it("adds one fill layer per twilight band", () => {
    render(<SunTimeLayer />);

    for (const id of BAND_LAYER_IDS) {
      expect(fake.state.layers.get(id)?.type).toBe("fill");
    }
    expect(layerRegistrations().find((r) => r.id === "sun-time-band-0")?.slot).toBe(
      "area-overlays",
    );
  });

  it("publishes sixteen band features into the shared source", () => {
    render(<SunTimeLayer />);

    const data = fake.state.sources.get(SOURCE_ID)?.data as GeoJSON.FeatureCollection | undefined;
    expect(data?.features).toHaveLength(16);
  });

  it("correlates each layer's filter with the matching band index in the published data", () => {
    render(<SunTimeLayer />);

    expect(fake.state.filters.get("sun-time-band-3")).toEqual(["==", ["get", "band"], 3]);

    const data = fake.state.sources.get(SOURCE_ID)?.data as GeoJSON.FeatureCollection | undefined;
    const bandValues = data?.features.map((f) => f.properties?.band).sort((a, b) => a - b);
    expect(bandValues).toEqual(Array.from({ length: 16 }, (_, i) => i));
  });

  it("disables antialiasing so nested rings do not seam", () => {
    render(<SunTimeLayer />);

    expect(fake.state.paint.get("sun-time-band-0")?.["fill-antialias"]).toBe(false);
  });

  it("removes every band layer when the overlay is hidden", () => {
    render(<SunTimeLayer />);
    expect(fake.state.layers.has("sun-time-band-0")).toBe(true);
    expect(fake.state.layers.has("sun-time-band-15")).toBe(true);

    act(() => {
      useSunTimeStore.setState({ layerVisible: false });
    });

    expect(fake.state.layers.has("sun-time-band-0")).toBe(false);
    expect(fake.state.layers.has("sun-time-band-15")).toBe(false);
    expect(fake.state.sources.has(SOURCE_ID)).toBe(false);
  });

  it("survives a base-map style reload with every band layer and its data intact", async () => {
    render(<SunTimeLayer />);
    // The retained payload replays through a bridge-internal microtask (see
    // useGeoJsonSourceDataBridge.test.tsx), which a synchronous act() does not
    // drain — flush it before asserting nothing was lost.
    act(() => {
      fake.map.setStyle({} as never);
    });
    await act(async () => {});

    for (const id of BAND_LAYER_IDS) {
      expect(fake.state.layers.get(id)?.type).toBe("fill");
    }
    const data = fake.state.sources.get(SOURCE_ID)?.data as GeoJSON.FeatureCollection | undefined;
    expect(data?.features).toHaveLength(16);
  });

  it("follows the wall clock, republishes on each tick, and stops after unmount", () => {
    vi.useFakeTimers();
    useSunTimeStore.setState({ timeMs: null });
    const { unmount } = render(<SunTimeLayer />);
    const initialSetDataCount = fake.state.counts.setData.get(SOURCE_ID) ?? 0;

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    const afterTickCount = fake.state.counts.setData.get(SOURCE_ID) ?? 0;
    expect(afterTickCount).toBeGreaterThan(initialSetDataCount);

    unmount();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(fake.state.counts.setData.get(SOURCE_ID)).toBe(afterTickCount);
  });
});

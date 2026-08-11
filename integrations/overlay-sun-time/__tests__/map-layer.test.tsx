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
});

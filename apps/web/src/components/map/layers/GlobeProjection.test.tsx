import { useLayerStore } from "@openmapx/core";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { layerRegistrations } from "@/integration-api/map/layerStack";
import { useMapAttributionStore } from "@/integration-api/overlay/mapAttributionStore";
import { createFakeMap } from "@/test";
import { GlobeProjection } from "./GlobeProjection";
import { GlobeSkyLayer } from "./globe/GlobeSkyLayer";

let fake: ReturnType<typeof createFakeMap>;
let context: { mapRef: { current: typeof fake.map }; mapReady: boolean; styleVersion: number };
let container: HTMLDivElement;
let projection: { type: string };
let sky: Record<string, unknown>;
const setProjection = vi.fn((value: unknown) => {
  projection = value as typeof projection;
});
const setSky = vi.fn((value: unknown) => {
  sky = value as typeof sky;
});
const SKY_ID = "openmapx-globe-sky";

vi.mock("@mui/material/styles", () => ({ useColorScheme: () => ({ mode: "dark" }) }));
vi.mock("@/integration-api/map/MapContext", () => ({ useMap: () => context }));

beforeEach(() => {
  fake = createFakeMap({ styleLoaded: true, baseLayers: [{ id: "labels", type: "symbol" }] });
  container = document.createElement("div");
  container.style.backgroundColor = "red";
  projection = { type: "mercator" };
  sky = {};
  Object.assign(fake.map, {
    getContainer: () => container,
    getProjection: () => projection,
    getSky: () => sky,
    setProjection,
    setSky,
  });
  context = { mapRef: { current: fake.map }, mapReady: true, styleVersion: 0 };
  useLayerStore.setState({
    globeView: true,
    globeCameraBehavior: "reveal",
    globeLighting: true,
    activeLayer: "satellite",
  });
  vi.clearAllMocks();
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GlobeProjection sky lifecycle", () => {
  it.each([true, false])(
    "applies globe=%s after tile loading finishes without a style reload",
    (enabled) => {
      useLayerStore.setState({ globeView: !enabled });
      render(<GlobeProjection />);
      fake.state.styleLoaded = false;
      act(() => useLayerStore.getState().setGlobeView(enabled));
      fake.state.styleLoaded = true;
      act(() => fake.emit("idle"));
      expect(projection.type).toBe(enabled ? "globe" : "mercator");
      expect(Boolean(fake.map.getLayer(SKY_ID))).toBe(enabled);
    },
  );

  it("does not repeat projection or sky mutations on styledata", () => {
    render(<GlobeProjection />);
    const projectionWrites = setProjection.mock.calls.length;
    const skyWrites = setSky.mock.calls.length;
    act(() => {
      fake.emit("styledata");
      fake.emit("styledata");
    });
    expect(setProjection).toHaveBeenCalledTimes(projectionWrites);
    expect(setSky).toHaveBeenCalledTimes(skyWrites);
  });

  it("cancels pending globe changes on replacement and unmount", () => {
    const { unmount } = render(<GlobeProjection />);
    fake.state.styleLoaded = false;
    act(() => useLayerStore.getState().setGlobeView(false));
    act(() => useLayerStore.getState().setGlobeView(true));
    unmount();
    const writes = setProjection.mock.calls.length;
    fake.state.styleLoaded = true;
    act(() => fake.emit("idle"));
    expect(setProjection).toHaveBeenCalledTimes(writes);
    expect(fake.map.getLayer(SKY_ID)).toBeUndefined();
    expect(fake.state.handlers.get("idle")?.size ?? 0).toBe(0);
  });

  it("keeps one sky layer for every base map and removes it with globe view", () => {
    const { unmount } = render(<GlobeProjection />);
    expect(setProjection).toHaveBeenLastCalledWith({ type: "globe" });
    expect([...fake.state.layers.keys()]).toEqual([SKY_ID, "labels"]);
    expect(fake.state.handlers.get("move")?.size ?? 0).toBe(0);
    const adds = fake.state.counts.addLayer.get(SKY_ID);

    act(() => useLayerStore.setState({ activeLayer: "default" }));
    expect(fake.map.getLayer(SKY_ID)).toBeDefined();
    expect(fake.state.counts.addLayer.get(SKY_ID)).toBe(adds);
    expect(container.style.backgroundColor).toBe("rgb(16, 24, 40)");

    act(() => useLayerStore.setState({ globeView: false }));
    expect(fake.map.getLayer(SKY_ID)).toBeUndefined();
    expect(layerRegistrations().find((r) => r.id === SKY_ID)).toBeUndefined();
    expect(setProjection).toHaveBeenLastCalledWith({ type: "mercator" });
    expect(container.style.backgroundColor).toBe("red");
    unmount();
    expect(fake.state.handlers.get("style.load")?.size ?? 0).toBe(0);
  });

  it("updates the sky in place when lighting or the base map changes", () => {
    const setOptions = vi.spyOn(GlobeSkyLayer.prototype, "setOptions");
    render(<GlobeProjection />);
    act(() => useLayerStore.getState().setGlobeLighting(false));
    expect(setOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({ lighting: false, base: "satellite", dark: true }),
    );
    act(() => useLayerStore.setState({ activeLayer: "cycling" }));
    expect(setOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({ base: "map", themeSky: [16 / 255, 24 / 255, 40 / 255] }),
    );
    expect(fake.state.counts.addLayer.get(SKY_ID)).toBe(1);
  });

  it("hands MapLibre's haze to the custom glow below zoom 5", () => {
    render(<GlobeProjection />);
    expect(sky["atmosphere-blend"]).toEqual([
      "interpolate",
      ["linear"],
      ["zoom"],
      0,
      0,
      5,
      0,
      7,
      0.32,
      8,
      0,
    ]);
    act(() => useLayerStore.setState({ activeLayer: "default" }));
    expect(sky["atmosphere-blend"]).toEqual([
      "interpolate",
      ["linear"],
      ["zoom"],
      0,
      0,
      5,
      0,
      7,
      0.37,
      8,
      0.25,
      11,
      0,
    ]);
  });

  it("keeps the background dark around the globe while the sky is space", () => {
    fake.state.zoom = 3;
    useLayerStore.setState({ activeLayer: "default" });
    render(<GlobeProjection />);
    expect(container.style.backgroundColor).toBe("rgb(2, 3, 6)");
    fake.state.zoom = 9;
    act(() => fake.emit("zoom"));
    expect(container.style.backgroundColor).toBe("rgb(16, 24, 40)");
  });

  it("moves the terminator once a minute while visible, without an animation loop", () => {
    vi.useFakeTimers();
    try {
      fake.state.zoom = 3;
      const repaint = vi.spyOn(fake.map, "triggerRepaint");
      const { unmount } = render(<GlobeProjection />);
      repaint.mockClear();
      act(() => vi.advanceTimersByTime(60_000));
      expect(repaint).toHaveBeenCalledTimes(1);

      const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
      act(() => vi.advanceTimersByTime(60_000));
      expect(repaint).toHaveBeenCalledTimes(1);
      visibility.mockReturnValue("visible");
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(repaint).toHaveBeenCalledTimes(2);

      fake.state.zoom = 9;
      act(() => fake.emit("zoom"));
      act(() => vi.advanceTimersByTime(120_000));
      expect(repaint).toHaveBeenCalledTimes(2);
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("credits the sky's imagery only while it is drawn", () => {
    const credits = () =>
      Object.values(useMapAttributionStore.getState().byLayer)
        .flat()
        .map((entry) => JSON.stringify(entry));
    fake.state.zoom = 3;
    const { unmount } = render(<GlobeProjection />);
    expect(credits().some((entry) => entry.includes("ESO/S. Brunier"))).toBe(true);
    expect(credits().some((entry) => entry.includes("NASA Earth Observatory"))).toBe(true);

    fake.state.zoom = 7.5;
    act(() => fake.emit("zoom"));
    expect(credits().some((entry) => entry.includes("ESO/S. Brunier"))).toBe(true);
    expect(credits().some((entry) => entry.includes("NASA Earth Observatory"))).toBe(false);

    fake.state.zoom = 3;
    act(() => fake.emit("zoom"));
    act(() => useLayerStore.getState().setGlobeLighting(false));
    expect(credits().some((entry) => entry.includes("NASA Earth Observatory"))).toBe(false);

    act(() => useLayerStore.setState({ globeView: false }));
    expect(credits()).toEqual([]);
    unmount();
  });

  it("waits for a parsed stylesheet and rebuilds a single sky after style/context replacement", () => {
    fake.state.styleLoaded = false;
    const parsedStyle = fake.map.getStyle();
    let parsed = false;
    vi.spyOn(fake.map, "getStyle").mockImplementation(() =>
      parsed ? parsedStyle : (undefined as never),
    );
    const { rerender, unmount } = render(<GlobeProjection />);
    expect(fake.map.getLayer(SKY_ID)).toBeUndefined();
    parsed = true;
    act(() => fake.emit("style.load"));
    expect(fake.map.getLayer(SKY_ID)).toBeDefined();

    fake.state.layers.delete(SKY_ID); // MapLibre drops custom layers on context loss.
    act(() => fake.emit("style.load"));
    context.styleVersion++;
    rerender(<GlobeProjection />);
    expect([...fake.state.layers.keys()].filter((id) => id === SKY_ID)).toHaveLength(1);
    expect(fake.state.cameraTransitions).toEqual([]);
    unmount();
    expect(fake.map.getLayer(SKY_ID)).toBeUndefined();
    expect(container.style.backgroundColor).toBe("red");
  });

  it("marks an animated globe reveal as an app camera movement", () => {
    fake.state.zoom = 14;
    render(<GlobeProjection />);
    expect(fake.state.cameraTransitions).toEqual([
      { method: "easeTo", options: { zoom: 3, duration: 1500 }, eventData: { programmatic: true } },
    ]);
  });

  it("keeps the reduced-motion globe reveal immediate and does not repeat it on style reload", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true })),
    );
    fake.state.zoom = 14;
    const { rerender } = render(<GlobeProjection />);
    expect(fake.state.cameraTransitions).toEqual([
      { method: "jumpTo", options: { zoom: 3 }, eventData: { programmatic: true } },
    ]);
    context.styleVersion++;
    rerender(<GlobeProjection />);
    expect(fake.state.cameraTransitions).toHaveLength(1);
  });
});

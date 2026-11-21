import {
  createOverlayStore,
  getRegisteredOverlayStore,
  type OverlayStoreBase,
  registerOverlayEntry,
  runOverlayTransaction,
  useLayerStore,
} from "@openmapx/core";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { layerRegistrations } from "@/integration-api/map/layerStack";
import {
  NEUTRAL_SCENE_LIGHT,
  NIGHT_SCENE_LIGHT,
  useSceneLightStore,
} from "@/integration-api/map/sceneLight";
import { useMapAttributionStore } from "@/integration-api/overlay/mapAttributionStore";
import { createFakeMap, nth } from "@/test";
import { GlobeProjection } from "./GlobeProjection";

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

const scheme = vi.hoisted(() => ({ mode: "dark" as "light" | "dark" }));
vi.mock("@mui/material/styles", () => ({ useColorScheme: () => ({ mode: scheme.mode }) }));
vi.mock("@/integration-api/map/MapContext", () => ({ useMap: () => context }));

interface FakeSky {
  options: Record<string, unknown>;
  events: {
    onContent?: (content: { milkyWay: boolean; nightLights: boolean }) => void;
    onUnavailable?: () => void;
  };
  setOptions: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}
const skies = vi.hoisted(() => [] as FakeSky[]);
vi.mock("./globe/GlobeSkyLayer", () => ({
  GlobeSkyLayer: class {
    readonly id = "openmapx-globe-sky";
    readonly type = "custom";
    readonly renderingMode = "2d";
    setOptions = vi.fn();
    dispose = vi.fn();
    constructor(
      public options: FakeSky["options"],
      public events: FakeSky["events"],
    ) {
      skies.push(this as unknown as FakeSky);
    }
  },
}));

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
  // The scene lighting publishes night for the dark theme these tests run in.
  scheme.mode = "dark";
  useSceneLightStore.setState({ light: NIGHT_SCENE_LIGHT });
  useLayerStore.setState({
    globeView: true,
    globeCameraBehavior: "reveal",
    globeLighting: true,
    activeLayer: "satellite",
  });
  vi.clearAllMocks();
  skies.length = 0;
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

  it("takes the globe's vector sky from the scene light", () => {
    scheme.mode = "light";
    useLayerStore.setState({ activeLayer: "default" });
    useSceneLightStore.setState({ light: NEUTRAL_SCENE_LIGHT });
    fake.state.zoom = 9;
    render(<GlobeProjection />);
    act(() =>
      useSceneLightStore.getState().publish({
        ...NEUTRAL_SCENE_LIGHT,
        preset: "dusk",
        sky: { skyColor: "#5d6fa8", horizonColor: "#e3b4a6", fogColor: "#c9c1d3" },
      }),
    );
    expect(setSky).toHaveBeenLastCalledWith(
      expect.objectContaining({
        "sky-color": "#5d6fa8",
        "horizon-color": "#e3b4a6",
        "fog-color": "#c9c1d3",
        "sky-horizon-blend": 0.5,
      }),
    );
    expect(container.style.backgroundColor).toBe("rgb(227, 180, 166)");
    expect(skies[0].setOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({ themeSky: [227 / 255, 180 / 255, 166 / 255] }),
    );
  });

  it("keeps today's sky for the neutral and night lights", () => {
    scheme.mode = "light";
    useLayerStore.setState({ activeLayer: "default" });
    useSceneLightStore.setState({ light: NEUTRAL_SCENE_LIGHT });
    fake.state.zoom = 9;
    const { unmount } = render(<GlobeProjection />);
    expect(sky).toMatchObject({
      "sky-color": "#88c6fc",
      "horizon-color": "#d6e8f7",
      "fog-color": "#ffffff",
      "sky-horizon-blend": 0.5,
    });
    unmount();

    scheme.mode = "dark";
    useSceneLightStore.setState({ light: NIGHT_SCENE_LIGHT });
    render(<GlobeProjection />);
    expect(sky).toMatchObject({
      "sky-color": "#0a0a1a",
      "horizon-color": "#101828",
      "fog-color": "#0a0a0a",
      "sky-horizon-blend": 0.6,
    });
  });

  it("leaves the mercator sky alone", () => {
    useLayerStore.setState({ globeView: false, activeLayer: "default" });
    render(<GlobeProjection />);
    act(() =>
      useSceneLightStore.getState().publish({
        ...NEUTRAL_SCENE_LIGHT,
        sky: { skyColor: "#5d6fa8", horizonColor: "#e3b4a6", fogColor: "#c9c1d3" },
      }),
    );
    expect(setSky).toHaveBeenLastCalledWith({ "atmosphere-blend": 0 });
  });

  it("leaves the satellite sky alone", () => {
    render(<GlobeProjection />);
    act(() =>
      useSceneLightStore.getState().publish({
        ...NEUTRAL_SCENE_LIGHT,
        sky: { skyColor: "#5d6fa8", horizonColor: "#e3b4a6", fogColor: "#c9c1d3" },
      }),
    );
    expect(sky).toMatchObject({ "sky-color": "#0a0a2e", "horizon-color": "#1a3a5e" });
  });

  it("updates the sky in place when lighting, the base map or the style changes", () => {
    const { rerender } = render(<GlobeProjection />);
    const setOptions = nth(skies, 0).setOptions;
    act(() => useLayerStore.getState().setGlobeLighting(false));
    expect(setOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({ lighting: false, base: "satellite", dark: true }),
    );
    act(() => useLayerStore.setState({ activeLayer: "cycling" }));
    expect(setOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({ base: "map", themeSky: [16 / 255, 24 / 255, 40 / 255] }),
    );
    context.styleVersion++;
    rerender(<GlobeProjection />);
    expect(skies).toHaveLength(1);
    expect(nth(skies, 0).dispose).not.toHaveBeenCalled();
    expect(fake.state.counts.addLayer.get(SKY_ID)).toBe(1);
  });

  it("suspends day and night while the Daylight & time zones overlay is open", () => {
    createOverlayStore({ overlayId: "sun-time", extra: {} });
    registerOverlayEntry({
      id: "sun-time",
      getState: () => getRegisteredOverlayStore("sun-time")?.getState() as OverlayStoreBase,
      useActive: () => false,
      excludes: [],
    });
    render(<GlobeProjection />);
    act(() => {
      runOverlayTransaction("sun-time", { panelOpen: true }, { kind: "user" });
    });
    expect(nth(skies, 0).setOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({ lighting: false }),
    );
    act(() => {
      runOverlayTransaction("sun-time", { panelOpen: false }, { kind: "user" });
    });
    expect(nth(skies, 0).setOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({ lighting: true }),
    );
  });

  it("falls back to MapLibre's haze and the theme's background when the GPU cannot run the sky", () => {
    fake.state.zoom = 3;
    useLayerStore.setState({ activeLayer: "default" });
    render(<GlobeProjection />);
    expect(container.style.backgroundColor).toBe("rgb(2, 3, 6)");
    act(() => nth(skies, 0).events.onUnavailable?.());
    expect(sky["atmosphere-blend"]).toEqual([
      "interpolate",
      ["linear"],
      ["zoom"],
      0,
      0.6,
      5,
      0.6,
      8,
      0.25,
      11,
      0,
    ]);
    expect(container.style.backgroundColor).toBe("rgb(16, 24, 40)");
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

  it("credits exactly the imagery the sky reports drawing", () => {
    const credits = () =>
      Object.values(useMapAttributionStore.getState().byLayer)
        .flat()
        .map((entry) => JSON.stringify(entry));
    const { unmount } = render(<GlobeProjection />);
    expect(credits()).toEqual([]);

    act(() => nth(skies, 0).events.onContent?.({ milkyWay: true, nightLights: true }));
    expect(credits().some((entry) => entry.includes("ESO/S. Brunier"))).toBe(true);
    expect(credits().some((entry) => entry.includes("NASA Earth Observatory"))).toBe(true);

    act(() => nth(skies, 0).events.onContent?.({ milkyWay: true, nightLights: false }));
    expect(credits().some((entry) => entry.includes("ESO/S. Brunier"))).toBe(true);
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

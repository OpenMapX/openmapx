import { useLayerStore } from "@openmapx/core";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { layerRegistrations } from "@/integration-api/map/layerStack";
import { createFakeMap } from "@/test";
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
const SPACE_ID = "openmapx-globe-space";

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
    activeLayer: "satellite",
  });
  vi.clearAllMocks();
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false })),
  );
});

afterEach(() => vi.unstubAllGlobals());

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
      expect(Boolean(fake.map.getLayer(SPACE_ID))).toBe(enabled);
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
    expect(fake.map.getLayer(SPACE_ID)).toBeUndefined();
    expect(fake.state.handlers.get("idle")?.size ?? 0).toBe(0);
  });

  it("shares the map render loop and cleans up when satellite or globe mode is disabled", () => {
    const { unmount } = render(<GlobeProjection />);
    expect(setProjection).toHaveBeenLastCalledWith({ type: "globe" });
    expect([...fake.state.layers.keys()]).toEqual([SPACE_ID, "labels"]);
    expect(fake.state.handlers.get("move")?.size ?? 0).toBe(0);

    act(() => useLayerStore.setState({ activeLayer: "default" }));
    expect(fake.map.getLayer(SPACE_ID)).toBeUndefined();
    expect(layerRegistrations().find((r) => r.id === SPACE_ID)).toBeUndefined();
    expect(container.style.backgroundColor).toBe("rgb(16, 24, 40)");

    act(() => useLayerStore.setState({ activeLayer: "satellite" }));
    expect(fake.map.getLayer(SPACE_ID)).toBeDefined();
    act(() => useLayerStore.setState({ globeView: false }));
    expect(fake.map.getLayer(SPACE_ID)).toBeUndefined();
    expect(setProjection).toHaveBeenLastCalledWith({ type: "mercator" });
    expect(container.style.backgroundColor).toBe("red");
    unmount();
    expect(fake.state.handlers.get("style.load")?.size ?? 0).toBe(0);
  });

  it("waits for a loaded style and rebuilds a single sky after style/context replacement", () => {
    fake.state.styleLoaded = false;
    const { rerender, unmount } = render(<GlobeProjection />);
    expect(fake.map.getLayer(SPACE_ID)).toBeUndefined();
    fake.state.styleLoaded = true;
    act(() => fake.emit("style.load"));
    expect(fake.map.getLayer(SPACE_ID)).toBeDefined();

    fake.state.layers.delete(SPACE_ID); // MapLibre drops custom layers on context loss.
    act(() => fake.emit("style.load"));
    context.styleVersion++;
    rerender(<GlobeProjection />);
    expect([...fake.state.layers.keys()].filter((id) => id === SPACE_ID)).toHaveLength(1);
    expect(fake.state.handlers.get("style.load")?.size).toBe(1);
    expect(fake.state.cameraTransitions).toEqual([]);
    unmount();
    expect(fake.map.getLayer(SPACE_ID)).toBeUndefined();
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

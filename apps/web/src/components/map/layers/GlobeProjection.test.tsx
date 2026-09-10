import { useLayerStore } from "@openmapx/core";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { layerRegistrations } from "@/integration-api/map/layerStack";
import { createFakeMap } from "@/test";
import { GlobeProjection } from "./GlobeProjection";

let fake: ReturnType<typeof createFakeMap>;
let context: { mapRef: { current: typeof fake.map }; mapReady: boolean; styleVersion: number };
let container: HTMLDivElement;
const setProjection = vi.fn();
const setSky = vi.fn();
const SPACE_ID = "openmapx-globe-space";

vi.mock("@mui/material/styles", () => ({ useColorScheme: () => ({ mode: "dark" }) }));
vi.mock("@/integration-api/map/MapContext", () => ({ useMap: () => context }));

beforeEach(() => {
  fake = createFakeMap({ styleLoaded: true, baseLayers: [{ id: "labels", type: "symbol" }] });
  container = document.createElement("div");
  container.style.backgroundColor = "red";
  Object.assign(fake.map, { getContainer: () => container, setProjection, setSky });
  context = { mapRef: { current: fake.map }, mapReady: true, styleVersion: 0 };
  useLayerStore.setState({ globeView: true, activeLayer: "satellite" });
  vi.clearAllMocks();
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false })),
  );
});

afterEach(() => vi.unstubAllGlobals());

describe("GlobeProjection sky lifecycle", () => {
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

  it("keeps the reduced-motion globe reveal immediate and does not repeat it on style reload", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true })),
    );
    fake.state.zoom = 14;
    const { rerender } = render(<GlobeProjection />);
    expect(fake.state.cameraTransitions).toEqual([
      { method: "jumpTo", options: { zoom: 3 }, eventData: undefined },
    ]);
    context.styleVersion++;
    rerender(<GlobeProjection />);
    expect(fake.state.cameraTransitions).toHaveLength(1);
  });
});

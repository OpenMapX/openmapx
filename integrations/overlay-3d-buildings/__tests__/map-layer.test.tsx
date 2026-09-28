import { getOverlayEntry, registerOverlayEntry, toggleOverlay } from "@openmapx/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createFakeMap, type FakeMap, render } from "@/test";
import manifest from "../manifest.json";
import { useBuildingsStore } from "../store";

let fake: FakeMap;
let mapRef: { current: FakeMap["map"] };

vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({
    mapRef,
    mapReady: true,
    styleVersion: 0,
  }),
}));

import { BuildingExtrusionLayer } from "../map-layer";

const LAYER_ID = "openmapx-3d-buildings";
const BUILDING_LAYER_ID = "base-buildings";
const SYMBOL_LAYER_ID = "place-labels";

// In the app, the integration registry is ready before this lazy map layer mounts.
if (!getOverlayEntry("3d-buildings")) {
  registerOverlayEntry({
    id: "3d-buildings",
    getState: () => useBuildingsStore.getState(),
    useActive: () => useBuildingsStore((s) => s.panelOpen && s.layerVisible),
    excludes: [],
  });
}

function addBaseStyle(): void {
  fake.state.sources.set("unrelated", { type: "vector" });
  fake.state.sources.set("city", { type: "vector" });
  fake.state.layers.set("roads", {
    id: "roads",
    type: "line",
    source: "unrelated",
    "source-layer": "road",
  });
  fake.state.layers.set(BUILDING_LAYER_ID, {
    id: BUILDING_LAYER_ID,
    type: "fill",
    source: "city",
    "source-layer": "building",
    layout: { visibility: "visible" },
  });
  fake.state.layers.set(SYMBOL_LAYER_ID, {
    id: SYMBOL_LAYER_ID,
    type: "symbol",
    source: "city",
    "source-layer": "place",
  });
}

beforeEach(() => {
  fake = createFakeMap({ zoom: 16, pitch: 20, maxPitch: 70 });
  mapRef = { current: fake.map };
  addBaseStyle();
  useBuildingsStore.setState({ panelOpen: false, layerVisible: false, userRevision: 0 });
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false })),
  );
});

afterEach(() => {
  useBuildingsStore.setState({ panelOpen: false, layerVisible: false, userRevision: 0 });
  vi.unstubAllGlobals();
});

describe("BuildingExtrusionLayer", () => {
  it("keeps flat buildings unobscured until the camera tilts", () => {
    fake.state.pitch = 0;
    render(<BuildingExtrusionLayer />);

    expect(fake.state.layers.get(LAYER_ID)?.layout?.visibility).toBe("none");
    expect(fake.state.layout.get(BUILDING_LAYER_ID)?.visibility).not.toBe("none");

    fake.state.pitch = 30;
    act(() => fake.emit("pitch"));
    expect(useBuildingsStore.getState().panelOpen).toBe(true);
    expect(fake.state.layout.get(LAYER_ID)?.visibility).toBe("visible");

    fake.state.pitch = 0;
    act(() => fake.emit("pitchend"));
    expect(useBuildingsStore.getState().panelOpen).toBe(false);
    expect(fake.state.layout.get(LAYER_ID)?.visibility).toBe("none");
    expect(fake.state.layout.get(BUILDING_LAYER_ID)?.visibility).not.toBe("none");

    fake.state.layers.delete(LAYER_ID);
    act(() => fake.emit("styledata"));
    expect(fake.state.layers.get(LAYER_ID)?.layout?.visibility).toBe("none");
  });

  it("enables the selector for an initially tilted camera", () => {
    render(<BuildingExtrusionLayer />);

    const layer = fake.state.layers.get(LAYER_ID);
    expect(useBuildingsStore.getState().panelOpen).toBe(true);
    expect(useBuildingsStore.getState().layerVisible).toBe(true);
    expect(manifest.frontend.overlay.minZoom).toBe(14);
    expect(layer?.minzoom).toBe(16.5);
    expect(layer?.source).toBe("city");
    expect(layer?.["source-layer"]).toBe("building");
    expect(layer?.source).not.toBe("unrelated");
    expect((layer?.paint as Record<string, unknown>)?.["fill-extrusion-opacity"]).toEqual([
      "interpolate",
      ["linear"],
      ["zoom"],
      16.5,
      0,
      17,
      1,
    ]);
    expect(fake.state.layout.get(BUILDING_LAYER_ID)?.visibility).not.toBe("none");
  });

  it("inserts the layer already below the first symbol layer, not via a later move", () => {
    render(<BuildingExtrusionLayer />);

    const ids = [...fake.state.layers.keys()];
    expect(ids.indexOf(LAYER_ID)).toBeLessThan(ids.indexOf(SYMBOL_LAYER_ID));
    expect(fake.state.movedLayers).toEqual([]);
  });

  it("restores its layer after a style reload without hiding the flat footprints", () => {
    render(<BuildingExtrusionLayer />);
    expect(fake.state.layout.get(BUILDING_LAYER_ID)?.visibility).not.toBe("none");

    fake.state.layers.delete(LAYER_ID);
    act(() => {
      fake.emit("styledata");
    });
    expect(fake.state.layers.has(LAYER_ID)).toBe(true);

    act(() => {
      toggleOverlay("3d-buildings", { kind: "user" });
    });
    expect(fake.state.layout.get(LAYER_ID)?.visibility).toBe("none");
  });

  it("lets the 3D view toggle tilt the camera without changing max pitch", () => {
    fake.state.pitch = 0;
    const { rerender } = render(<BuildingExtrusionLayer />);
    expect(fake.state.cameraTransitions).toEqual([]);

    act(() => {
      useBuildingsStore.setState({ layerVisible: true });
    });
    rerender(<BuildingExtrusionLayer />);
    expect(fake.state.maxPitch).toBe(70);
    expect(fake.state.cameraTransitions.at(-1)).toEqual({
      method: "easeTo",
      options: { pitch: 45, duration: 800 },
    });

    act(() => {
      toggleOverlay("3d-buildings", { kind: "user" });
    });
    rerender(<BuildingExtrusionLayer />);

    expect(fake.state.pitch).toBe(45);
    expect(fake.state.maxPitch).toBe(70);
    expect(fake.state.cameraTransitions).toHaveLength(1);
    expect(fake.state.layout.get(LAYER_ID)?.visibility).toBe("none");
  });

  it("keeps manual 3D off while tilted until returning overhead and tilting again", () => {
    render(<BuildingExtrusionLayer />);
    expect(useBuildingsStore.getState().layerVisible).toBe(true);

    act(() => toggleOverlay("3d-buildings", { kind: "user" }));
    expect(useBuildingsStore.getState().panelOpen).toBe(false);
    expect(fake.state.layout.get(LAYER_ID)?.visibility).toBe("none");

    fake.state.pitch = 28;
    act(() => {
      fake.emit("pitch");
      fake.emit("moveend");
    });
    expect(useBuildingsStore.getState().layerVisible).toBe(false);
    expect(fake.state.layout.get(LAYER_ID)?.visibility).toBe("none");
    expect(fake.state.cameraTransitions).toEqual([]);

    fake.state.pitch = 0;
    act(() => fake.emit("pitchend"));
    expect(useBuildingsStore.getState().layerVisible).toBe(false);

    fake.state.pitch = 28;
    act(() => fake.emit("pitch"));
    expect(useBuildingsStore.getState().panelOpen).toBe(true);
    expect(fake.state.layout.get(LAYER_ID)?.visibility).toBe("visible");
    expect(fake.state.cameraTransitions).toEqual([]);
  });

  it("uses immediate camera changes when reduced motion is requested", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true })),
    );
    fake.state.pitch = 0;
    useBuildingsStore.setState({ layerVisible: true });

    render(<BuildingExtrusionLayer />);

    expect(fake.state.pitch).toBe(45);
    expect(fake.state.cameraTransitions).toContainEqual({
      method: "jumpTo",
      options: { pitch: 45 },
    });
    expect(fake.state.cameraTransitions.some((transition) => transition.method === "easeTo")).toBe(
      false,
    );
  });
});

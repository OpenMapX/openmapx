import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createFakeMap, type FakeMap, render } from "@/test";
import manifest from "../manifest.json";
import { useBuildingsStore } from "../store";

let fake: FakeMap;

vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({
    mapRef: { current: fake.map },
    mapReady: true,
    styleVersion: 0,
  }),
}));

import { BuildingExtrusionLayer } from "../map-layer";

const LAYER_ID = "openmapx-3d-buildings";
const BUILDING_LAYER_ID = "base-buildings";
const SYMBOL_LAYER_ID = "place-labels";

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
  addBaseStyle();
  useBuildingsStore.setState({ panelOpen: false, layerVisible: false });
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false })),
  );
});

afterEach(() => {
  useBuildingsStore.setState({ panelOpen: false, layerVisible: false });
  vi.unstubAllGlobals();
});

describe("BuildingExtrusionLayer", () => {
  it("uses the building source and keeps the manifest and map-layer minimum zoom aligned", () => {
    useBuildingsStore.setState({ layerVisible: true });
    render(<BuildingExtrusionLayer />);

    const layer = fake.state.layers.get(LAYER_ID);
    expect(manifest.frontend.overlay.minZoom).toBe(14);
    expect(layer?.minzoom).toBe(manifest.frontend.overlay.minZoom);
    expect(layer?.source).toBe("city");
    expect(layer?.["source-layer"]).toBe("building");
    expect(layer?.source).not.toBe("unrelated");
  });

  it("inserts the layer already below the first symbol layer, not via a later move", () => {
    useBuildingsStore.setState({ layerVisible: true });
    render(<BuildingExtrusionLayer />);

    const ids = [...fake.state.layers.keys()];
    expect(ids.indexOf(LAYER_ID)).toBeLessThan(ids.indexOf(SYMBOL_LAYER_ID));
    expect(fake.state.movedLayers).toEqual([]);
  });

  it("restores its layer after a style reload and toggles original building visibility", () => {
    useBuildingsStore.setState({ layerVisible: true });
    render(<BuildingExtrusionLayer />);
    expect(fake.state.layout.get(BUILDING_LAYER_ID)?.visibility).toBe("none");

    fake.state.layers.delete(LAYER_ID);
    act(() => {
      fake.emit("styledata");
    });
    expect(fake.state.layers.has(LAYER_ID)).toBe(true);

    act(() => {
      useBuildingsStore.setState({ layerVisible: false });
    });
    expect(fake.state.layout.get(LAYER_ID)?.visibility).toBe("none");
    expect(fake.state.layout.get(BUILDING_LAYER_ID)?.visibility).toBe("visible");
  });

  it("restores the exact pitch and maximum pitch captured before enabling", () => {
    const { rerender } = render(<BuildingExtrusionLayer />);

    act(() => {
      useBuildingsStore.setState({ layerVisible: true });
    });
    rerender(<BuildingExtrusionLayer />);
    expect(fake.state.maxPitch).toBe(85);

    fake.state.pitch = 55;
    act(() => {
      useBuildingsStore.setState({ layerVisible: false });
    });
    rerender(<BuildingExtrusionLayer />);

    expect(fake.state.pitch).toBe(20);
    expect(fake.state.maxPitch).toBe(70);
    expect(fake.state.cameraTransitions.at(-1)).toEqual({
      method: "easeTo",
      options: { pitch: 20, duration: 600 },
    });
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

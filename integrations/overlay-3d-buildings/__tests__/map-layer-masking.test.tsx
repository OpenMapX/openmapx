import {
  type BuildingReplacement,
  getOverlayEntry,
  registerOverlayEntry,
  useBuildingReplacementStore,
  useNavigationStore,
} from "@openmapx/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createFakeMap, type FakeMap, render } from "@/test";
import { MASKED_SOURCE_ID } from "../masked-source";
import { useBuildingsStore } from "../store";

let fake: FakeMap;
let mapRef: { current: FakeMap["map"] };

vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ mapRef, mapReady: true, styleVersion: 0 }),
}));

import { BuildingExtrusionLayer } from "../map-layer";

const LAYER_ID = "openmapx-3d-buildings";
const TILES = ["https://tiles.example/{z}/{x}/{y}.pbf"];

if (!getOverlayEntry("3d-buildings")) {
  registerOverlayEntry({
    id: "3d-buildings",
    getState: () => useBuildingsStore.getState(),
    useActive: () => useBuildingsStore((s) => s.panelOpen && s.layerVisible),
    excludes: [],
  });
}

function addBaseStyle(tiles?: string[]): void {
  fake.state.sources.set("city", { type: "vector", ...(tiles ? { tiles, maxzoom: 14 } : {}) });
  fake.state.layers.set("base-buildings", {
    id: "base-buildings",
    type: "fill",
    source: "city",
    "source-layer": "building",
    layout: { visibility: "visible" },
  });
  fake.state.layers.set("place-labels", {
    id: "place-labels",
    type: "symbol",
    source: "city",
    "source-layer": "place",
  });
}

const eiffel: BuildingReplacement = {
  id: "eiffel",
  featureIds: [2264135082],
  bbox: [2.2944, 48.8582, 2.2946, 48.8586],
};

function useView(bounds: { west: number; south: number; east: number; north: number }): void {
  fake = createFakeMap({ zoom: 16, pitch: 20, maxPitch: 70, bounds });
  mapRef.current = fake.map;
}

function resetStore(): void {
  const state = useBuildingReplacementStore.getState();
  for (const owner of state.owners) state.clear(owner);
  state.setMaskingAvailable(false);
}

beforeEach(() => {
  useNavigationStore.setState({ status: "idle" });
  fake = createFakeMap({ zoom: 16, pitch: 20, maxPitch: 70 });
  mapRef = { current: fake.map };
  useBuildingsStore.setState({ panelOpen: true, layerVisible: true, userRevision: 0 });
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false })),
  );
  resetStore();
});

afterEach(() => {
  resetStore();
  useBuildingsStore.setState({ panelOpen: false, layerVisible: false, userRevision: 0 });
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("BuildingExtrusionLayer masking", () => {
  it("maskingAvailable turns true on metadata sourcedata", () => {
    addBaseStyle();
    render(<BuildingExtrusionLayer />);
    expect(useBuildingReplacementStore.getState().maskingAvailable).toBe(false);
    (fake.state.sources.get("city") as Record<string, unknown>).tiles = TILES;
    act(() => fake.emit("sourcedata", { sourceId: "city", sourceDataType: "metadata" }));
    expect(useBuildingReplacementStore.getState().maskingAvailable).toBe(true);
  });

  it("is not maskable for a non-http building source", () => {
    addBaseStyle(["pmtiles://archive/{z}/{x}/{y}"]);
    render(<BuildingExtrusionLayer />);
    expect(useBuildingReplacementStore.getState().maskingAvailable).toBe(false);
  });

  it("never adds the masked source without an owner", () => {
    addBaseStyle(TILES);
    render(<BuildingExtrusionLayer />);
    expect(useBuildingReplacementStore.getState().maskingAvailable).toBe(true);
    expect(fake.state.sources.has(MASKED_SOURCE_ID)).toBe(false);
    expect(fake.state.layers.get(LAYER_ID)?.source).toBe("city");
  });

  it("switches the extrusion layer to the masked source once an owner registers", () => {
    addBaseStyle(TILES);
    render(<BuildingExtrusionLayer />);
    act(() => useBuildingReplacementStore.getState().setReplacements("landmarks", []));
    expect(fake.state.sources.has(MASKED_SOURCE_ID)).toBe(true);
    expect(fake.state.layers.get(LAYER_ID)?.source).toBe(MASKED_SOURCE_ID);
    expect(fake.state.layers.get(LAYER_ID)?.["source-layer"]).toBe("building");
    // Later changes do not swap the layer again.
    const adds = fake.state.counts.addLayer.get(LAYER_ID);
    act(() => useBuildingReplacementStore.getState().setReplacements("landmarks", [eiffel]));
    expect(fake.state.counts.addLayer.get(LAYER_ID)).toBe(adds);
  });

  it("reloads the masked source under a new revision after replacements change", () => {
    vi.useFakeTimers();
    useView({ west: 2.28, south: 48.85, east: 2.31, north: 48.87 });
    addBaseStyle(TILES);
    render(<BuildingExtrusionLayer />);
    act(() => useBuildingReplacementStore.getState().setReplacements("landmarks", []));
    act(() => useBuildingReplacementStore.getState().setReplacements("landmarks", [eiffel]));
    const source = () => fake.state.sources.get(MASKED_SOURCE_ID) as Record<string, unknown>;
    expect(source().setTilesCalls).toBeUndefined();
    act(() => vi.advanceTimersByTime(150));
    expect(source().setTilesCalls).toBe(1);
    const revision = useBuildingReplacementStore.getState().revision;
    expect(source().tiles).toEqual([`openmapx-buildings://{z}/{x}/{y}?r=${revision}`]);
    // MapLibre's refreshTiles answers overzoomed tiles without calling the protocol again.
    expect(fake.state.refreshedTiles).toEqual([]);
  });

  it("does not reload when the replacements are unchanged", () => {
    vi.useFakeTimers();
    addBaseStyle(TILES);
    render(<BuildingExtrusionLayer />);
    act(() => useBuildingReplacementStore.getState().setReplacements("landmarks", [eiffel]));
    act(() => vi.advanceTimersByTime(150));
    act(() => useBuildingReplacementStore.getState().setReplacements("landmarks", [eiffel]));
    act(() => vi.advanceTimersByTime(150));
    expect(fake.state.sources.get(MASKED_SOURCE_ID)?.setTilesCalls).toBe(1);
  });
});

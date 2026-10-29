// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CYCLING_LAYER_IDS } from "@/integration-api/map/cyclingConfig";
import { layerRegistrations } from "@/integration-api/map/layerStack";
import { act, createFakeMap, type FakeMap, render } from "@/test";

const mapContext = vi.hoisted(() => ({ mapRef: { current: null as FakeMap["map"] | null } }));

vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ mapRef: mapContext.mapRef, mapReady: true, styleVersion: 0 }),
}));

import { CyclingLayer } from "../map-layer";
import { useCyclingStore } from "../store";

const BASEMAP_LAYERS = [
  { id: "road", type: "line", source: "basemap", "source-layer": "transportation" },
  { id: "poi-label", type: "symbol", source: "basemap", "source-layer": "poi" },
];

const ALL_LAYER_IDS = Object.values(CYCLING_LAYER_IDS);

let fake: FakeMap;

function setVisible(layerVisible: boolean) {
  act(() => useCyclingStore.setState({ layerVisible }));
}

beforeEach(() => {
  fake = createFakeMap({ baseLayers: BASEMAP_LAYERS as never });
  mapContext.mapRef.current = fake.map;
  useCyclingStore.setState({ panelOpen: true, layerVisible: true, autoEnabled: false });
});

afterEach(() => {
  useCyclingStore.setState({ panelOpen: false, layerVisible: false, autoEnabled: false });
});

describe("CyclingLayer map layers", () => {
  it("draws from the basemap's own vector sources in declared slots", () => {
    render(<CyclingLayer />);

    for (const id of ALL_LAYER_IDS) {
      expect(fake.state.layers.get(id)).toMatchObject({ source: "basemap" });
    }
    expect(fake.state.layers.get(CYCLING_LAYER_IDS.tracks)).toMatchObject({
      "source-layer": "transportation",
    });
    expect(fake.state.layers.get(CYCLING_LAYER_IDS.parking)).toMatchObject({
      "source-layer": "poi",
    });
    expect(fake.state.sources.size).toBe(0);
    expect(layerRegistrations()).toEqual(
      expect.arrayContaining([
        { id: CYCLING_LAYER_IDS.tracks, slot: "overlay-lines", order: 0 },
        { id: CYCLING_LAYER_IDS.permitted, slot: "overlay-lines", order: 3 },
        { id: CYCLING_LAYER_IDS.parking, slot: "overlay-points", order: 9 },
        { id: CYCLING_LAYER_IDS.shops, slot: "overlay-points", order: 10 },
        { id: CYCLING_LAYER_IDS.labels, slot: "overlay-markers", order: 2 },
      ]),
    );
  });

  it("hides its layers without removing them and shows them again", () => {
    render(<CyclingLayer />);

    setVisible(false);
    for (const id of ALL_LAYER_IDS) {
      expect(fake.state.layers.has(id)).toBe(true);
      expect(fake.state.layout.get(id)?.visibility).toBe("none");
    }

    setVisible(true);
    for (const id of ALL_LAYER_IDS) {
      expect(fake.state.layout.get(id)?.visibility).toBe("visible");
    }
  });

  it("re-adds its layers after a style replacement while visible", () => {
    render(<CyclingLayer />);

    act(() => fake.map.setStyle({} as never));

    for (const id of ALL_LAYER_IDS) expect(fake.state.layers.has(id)).toBe(true);
  });

  it("does not add layers while hidden, including after a style replacement", () => {
    useCyclingStore.setState({ layerVisible: false });
    render(<CyclingLayer />);
    act(() => fake.map.setStyle({} as never));

    for (const id of ALL_LAYER_IDS) expect(fake.state.layers.has(id)).toBe(false);
  });

  it("draws only the layers whose basemap source layer the style has", () => {
    fake = createFakeMap({ baseLayers: [BASEMAP_LAYERS[0]] as never });
    mapContext.mapRef.current = fake.map;
    render(<CyclingLayer />);

    expect(fake.state.layers.has(CYCLING_LAYER_IDS.tracks)).toBe(true);
    expect(fake.state.layers.has(CYCLING_LAYER_IDS.parking)).toBe(false);
    expect(fake.state.layers.has(CYCLING_LAYER_IDS.labels)).toBe(false);
  });
});

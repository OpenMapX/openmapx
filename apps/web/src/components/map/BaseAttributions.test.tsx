// @vitest-environment jsdom

import { useLayerStore } from "@openmapx/core";
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BaseAttributions } from "./BaseAttributions";

/**
 * Fake MapLibre map that records every source registered through the real
 * `useMapAttributions` hook. MapLibre's AttributionControl renders the
 * concatenation of each used source's `attribution` string, so asserting on the
 * strings we register here is asserting on what the control would display.
 *
 * `state`/`fakeMap` are referenced only inside the mock factories' returned
 * callbacks (called at render time), so they're safe to declare as plain module
 * consts even though Vitest hoists the `vi.mock` calls above them.
 */
const state = {
  sources: new Map<string, { attribution?: string }>(),
  layers: new Set<string>(),
  env: { styleProvider: "openmapx" as "openmapx" | "maptiler" },
};

const fakeMap = {
  isStyleLoaded: () => true,
  getSource: (id: string) => state.sources.get(id),
  addSource: (id: string, opts: { attribution?: string }) => {
    state.sources.set(id, opts);
  },
  removeSource: (id: string) => {
    state.sources.delete(id);
  },
  getLayer: (id: string) => state.layers.has(id),
  addLayer: (layer: { id: string }) => {
    state.layers.add(layer.id);
  },
  removeLayer: (id: string) => {
    state.layers.delete(id);
  },
  on: () => {},
  off: () => {},
  once: () => {},
};

vi.mock("@/lib/MapContext", () => ({
  useMap: () => ({
    mapRef: { current: fakeMap as unknown as import("maplibre-gl").Map },
    mapReady: true,
    styleVersion: 0,
  }),
}));

vi.mock("@/lib/EnvProvider", () => ({
  useEnv: () => state.env,
}));

function registeredAttributions(): string[] {
  return [...state.sources.values()].map((s) => s.attribution ?? "");
}

const creditsOsm = () => registeredAttributions().some((a) => a.includes("OpenStreetMap"));

beforeEach(() => {
  state.sources.clear();
  state.layers.clear();
  state.env.styleProvider = "openmapx";
  useLayerStore.setState({ activeLayer: "default" });
});

describe("BaseAttributions — base OSM-credit invariant", () => {
  it("registers an OpenStreetMap credit for the OpenMapTiles vector base", () => {
    state.env.styleProvider = "openmapx";
    render(<BaseAttributions />);
    expect(creditsOsm()).toBe(true);
  });

  it("registers an OpenStreetMap credit for the MapTiler vector base", () => {
    state.env.styleProvider = "maptiler";
    render(<BaseAttributions />);
    expect(creditsOsm()).toBe(true);
  });

  it("does NOT force an OSM credit when a non-OSM raster base (satellite) is active", () => {
    // Guards against misattributing imagery to OSM: while a raster base owns the
    // screen, the vector-base credits (including OSM) are dropped and the raster
    // layer registers its own credit instead.
    useLayerStore.setState({ activeLayer: "satellite" });
    render(<BaseAttributions />);
    expect(creditsOsm()).toBe(false);
  });
});

// @vitest-environment jsdom

import { useLayerStore } from "@openmapx/core";
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMapAttributionStore } from "@/integration-api/overlay/mapAttributionStore";
import { BaseAttributions } from "./BaseAttributions";

/**
 * `<MapFooter>` renders whatever the attribution registry holds, so asserting
 * on the registry contents after rendering `<BaseAttributions>` is asserting on
 * what the credits strip would display.
 */
const state = {
  env: { styleProvider: "openmapx" as "openmapx" | "maptiler" },
};

vi.mock("@/integration-api/runtime/EnvProvider", () => ({
  useEnv: () => state.env,
}));

function registeredAttributions(): string[] {
  return Object.values(useMapAttributionStore.getState().byLayer).flat();
}

const creditsOsm = () => registeredAttributions().some((a) => a.includes("OpenStreetMap"));

beforeEach(() => {
  useMapAttributionStore.setState({ byLayer: {} });
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

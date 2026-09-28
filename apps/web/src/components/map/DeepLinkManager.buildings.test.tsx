import { BuildingExtrusionLayer } from "@integrations/overlay-3d-buildings/map-layer";
import { useBuildingsStore } from "@integrations/overlay-3d-buildings/store";
import { initOverlayRegistry, toggleOverlay } from "@openmapx/core";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEEPLINK_UPDATE_EVENT } from "@/lib/deepLink";
import { createFakeMap, type FakeMap } from "@/test";
import { DeepLinkManager } from "./DeepLinkManager";

let fake: FakeMap;
let context: { mapRef: { current: FakeMap["map"] }; mapReady: boolean; styleVersion: number };
vi.mock("@/integration-api/map/MapContext", () => ({ useMap: () => context }));
const BUILDINGS = {
  id: "overlay-3d-buildings",
  name: "Buildings",
  enabled: true,
  domains: ["map-overlay"],
  frontend: { overlay: { excludes: [] } },
};
const VIEW = "/?map=50.778,6.0805,17.5,23,45";

beforeEach(() => {
  fake = createFakeMap({ zoom: 17.5, pitch: 0 });
  context = { mapRef: { current: fake.map }, mapReady: true, styleVersion: 0 };
  fake.state.sources.set("city", { type: "vector" });
  fake.state.layers.set("buildings", {
    id: "buildings",
    type: "fill",
    source: "city",
    "source-layer": "building",
  });
  Object.assign(fake.map, { getContainer: () => document.createElement("div") });
  const jumpTo = fake.map.jumpTo.bind(fake.map);
  fake.map.jumpTo = (options, eventData) => {
    if (options.zoom !== undefined) fake.state.zoom = options.zoom;
    if (options.bearing !== undefined) fake.state.bearing = options.bearing;
    const pitch = fake.state.pitch;
    const result = jumpTo(options, eventData);
    if (pitch !== fake.state.pitch) fake.emit("pitch");
    return result;
  };
  useBuildingsStore.setState(useBuildingsStore.getInitialState(), true);
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false })),
  );
  window.history.replaceState(null, "", "/");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

function Scene({ buildings = true }: { buildings?: boolean }) {
  return (
    <>
      {buildings && <BuildingExtrusionLayer />}
      <DeepLinkManager />
    </>
  );
}
function updateUrl() {
  window.dispatchEvent(new Event(DEEPLINK_UPDATE_EVENT));
}
function pitch(value: number) {
  act(() => {
    fake.state.pitch = value;
    fake.emit("pitch");
  });
}

describe("building camera restoration", () => {
  // Deliberately first: this file begins with an uninitialized overlay registry.
  it("preserves off before registry readiness and lazy building-layer mounting", () => {
    window.history.replaceState(null, "", `${VIEW}&buildings=0&ov=3d-buildings`);
    const { rerender } = render(<Scene buildings={false} />);
    act(() => initOverlayRegistry([BUILDINGS]));
    rerender(<Scene />);
    expect(fake.map.getPitch()).toBe(45);
    expect(useBuildingsStore.getState().layerVisible).toBe(false);
    expect(fake.map.getLayoutProperty("openmapx-3d-buildings", "visibility")).toBe("none");
    pitch(55);
    expect(useBuildingsStore.getState().layerVisible).toBe(false);
    pitch(0);
    pitch(45);
    expect(useBuildingsStore.getState().layerVisible).toBe(true);
  });

  it("restores an explicit off link with camera listeners already mounted", () => {
    initOverlayRegistry([BUILDINGS]);
    window.history.replaceState(null, "", `${VIEW}&buildings=0`);
    render(<Scene />);
    expect(fake.map.getPitch()).toBe(45);
    expect(useBuildingsStore.getState().layerVisible).toBe(false);
    expect(window.location.search).toContain("buildings=0");
  });

  it("rearms automation for an off link restored directly to top-down", () => {
    initOverlayRegistry([BUILDINGS]);
    window.history.replaceState(null, "", "/?map=50.778,6.0805,17.5,0,0&buildings=0");
    render(<Scene />);
    expect(useBuildingsStore.getState().layerVisible).toBe(false);
    pitch(45);
    expect(useBuildingsStore.getState().layerVisible).toBe(true);
  });

  it("round-trips manual-off through sharing and history, and allows explicit selection", () => {
    initOverlayRegistry([BUILDINGS]);
    window.history.replaceState(null, "", VIEW);
    render(<Scene />);
    expect(useBuildingsStore.getState().layerVisible).toBe(true);
    act(() => toggleOverlay("3d-buildings", { kind: "user" }));
    act(updateUrl);
    const shared = window.location.search;
    expect(shared).toContain("buildings=0");
    expect(shared).not.toContain("ov=");
    pitch(0);
    pitch(45);
    expect(useBuildingsStore.getState().layerVisible).toBe(true);
    act(() => {
      window.history.pushState(null, "", shared);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(useBuildingsStore.getState().layerVisible).toBe(false);
    expect(fake.map.getPitch()).toBe(45);
    act(() => toggleOverlay("3d-buildings", { kind: "user" }));
    act(updateUrl);
    expect(useBuildingsStore.getState().layerVisible).toBe(true);
    expect(window.location.search).not.toContain("buildings=0");
    expect(window.location.search).toContain("ov=3d-buildings");
  });
});

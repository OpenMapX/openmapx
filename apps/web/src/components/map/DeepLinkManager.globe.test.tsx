import { initOverlayRegistry, useLayerStore } from "@openmapx/core";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeMap, type FakeMap } from "@/test";
import { DeepLinkManager } from "./DeepLinkManager";
import { GlobeProjection } from "./layers/GlobeProjection";

let fake: FakeMap;
let context: { mapRef: { current: FakeMap["map"] }; mapReady: boolean; styleVersion: number };
vi.mock("@/integration-api/map/MapContext", () => ({ useMap: () => context }));
vi.mock("@mui/material/styles", () => ({ useColorScheme: () => ({ mode: "light" }) }));

beforeEach(() => {
  fake = createFakeMap({ zoom: 17.5 });
  context = { mapRef: { current: fake.map }, mapReady: true, styleVersion: 0 };
  let projection = { type: "mercator" };
  let sky = {};
  Object.assign(fake.map, {
    getContainer: () => document.createElement("div"),
    getProjection: () => projection,
    setProjection: (value: typeof projection) => {
      projection = value;
    },
    getSky: () => sky,
    setSky: (value: typeof sky) => {
      sky = value;
    },
  });
  // This scenario needs camera readback, including zoom, after each command.
  const jumpTo = fake.map.jumpTo.bind(fake.map);
  fake.map.jumpTo = (options, eventData) => {
    if (options.zoom !== undefined) fake.state.zoom = options.zoom;
    if (options.bearing !== undefined) fake.state.bearing = options.bearing;
    return jumpTo(options, eventData);
  };
  const easeTo = fake.map.easeTo.bind(fake.map);
  fake.map.easeTo = (options, eventData) => {
    if (options.zoom !== undefined) fake.state.zoom = options.zoom;
    if (options.bearing !== undefined) fake.state.bearing = options.bearing;
    return easeTo(options, eventData);
  };
  initOverlayRegistry([]);
  useLayerStore.getState().setGlobeView(false);
  useLayerStore.getState().setActiveLayer("default");
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

function Scene() {
  return (
    <>
      <GlobeProjection />
      <DeepLinkManager />
    </>
  );
}

const VIEW = "/?map=50.778,6.0805,17.5,23,45&globe=1";

describe("globe camera restoration", () => {
  it.each([false, true])(
    "preserves a linked camera on first load with persisted globe=%s",
    (persisted) => {
      useLayerStore.setState({ globeView: persisted });
      window.history.replaceState(null, "", VIEW);
      render(<Scene />);
      expect(fake.map.getZoom()).toBe(17.5);
      expect(fake.map.getPitch()).toBe(45);
      expect(fake.map.getBearing()).toBe(23);
      expect(fake.map.getProjection()).toEqual({ type: "globe" });
      expect(window.location.search).toContain("17.5");
    },
  );

  it("leaves the camera and projection as they are on a history traversal", () => {
    render(<Scene />);
    const before = {
      zoom: fake.map.getZoom(),
      pitch: fake.map.getPitch(),
      projection: fake.map.getProjection(),
    };
    act(() => {
      window.history.pushState(null, "", VIEW);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    // Back/Forward step through open surfaces only; the map stays where the
    // user left it, as in a native map app.
    expect(fake.map.getZoom()).toBe(before.zoom);
    expect(fake.map.getPitch()).toBe(before.pitch);
    expect(fake.map.getProjection()).toEqual(before.projection);
  });
});

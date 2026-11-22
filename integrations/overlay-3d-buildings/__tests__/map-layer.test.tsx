import {
  getOverlayEntry,
  registerOverlayEntry,
  setOverlayLayerVisible,
  toggleOverlay,
  useNavigationStore,
  useSettingsStore,
} from "@openmapx/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { layerRegistrations } from "@/integration-api/map/layerStack";
import { useNavigationSceneStore } from "@/integration-api/map/navigationScene";
import { act, createFakeMap, type FakeMap, render } from "@/test";
import {
  CONTACT_LAYER_ID,
  findBuildingRoofColor,
  findBuildingSourceReference,
} from "../building-style";
import manifest from "../manifest.json";
import { useBuildingsStore } from "../store";

let fake: FakeMap;
let styleVersion = 0;
let mapRef: { current: FakeMap["map"] };

vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({
    mapRef,
    mapReady: true,
    styleVersion,
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
  useNavigationStore.setState({ status: "idle", mode: "driving" });
  useSettingsStore.setState({ navigation3d: false });
  styleVersion = 0;
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

describe("BuildingExtrusionLayer scene slot", () => {
  const slotOf = (id: string) => layerRegistrations().find((r) => r.id === id);

  beforeEach(() => {
    useBuildingsStore.setState({ layerVisible: true });
  });
  afterEach(() => {
    useNavigationSceneStore.getState().setActive(false);
  });

  it("adds its layer in scene-3d while the navigation scene is active", () => {
    act(() => useNavigationSceneStore.getState().setActive(true));
    render(<BuildingExtrusionLayer />);
    expect(slotOf(LAYER_ID)).toMatchObject({ slot: "scene-3d", order: 5 });
    expect(slotOf(CONTACT_LAYER_ID)).toMatchObject({ slot: "scene-3d", order: 4.5 });
  });

  it("moves back to area-overlays when it ends", () => {
    render(<BuildingExtrusionLayer />);
    expect(slotOf(LAYER_ID)?.slot).toBe("area-overlays");
    act(() => useNavigationSceneStore.getState().setActive(true));
    expect(slotOf(LAYER_ID)?.slot).toBe("scene-3d");
    expect(slotOf(CONTACT_LAYER_ID)?.slot).toBe("scene-3d");
    act(() => useNavigationSceneStore.getState().setActive(false));
    expect(slotOf(LAYER_ID)).toMatchObject({ slot: "area-overlays", order: 5 });
    expect(slotOf(CONTACT_LAYER_ID)).toMatchObject({ slot: "area-overlays", order: 4.5 });
  });

  it("a style swap during 3D navigation re-adds it in scene-3d", () => {
    act(() => useNavigationSceneStore.getState().setActive(true));
    render(<BuildingExtrusionLayer />);
    fake.state.layers.delete(LAYER_ID);
    fake.state.layers.delete(CONTACT_LAYER_ID);
    act(() => {
      fake.emit("styledataloading");
      fake.emit("style.load");
    });
    expect(fake.state.layers.has(LAYER_ID)).toBe(true);
    expect(slotOf(LAYER_ID)?.slot).toBe("scene-3d");
    expect(slotOf(CONTACT_LAYER_ID)?.slot).toBe("scene-3d");
  });
});

describe("BuildingExtrusionLayer", () => {
  it("draws a contact shadow just below the extrusions", () => {
    render(<BuildingExtrusionLayer />);
    expect(fake.state.layers.get(CONTACT_LAYER_ID)).toMatchObject({
      type: "line",
      source: "city",
      "source-layer": "building",
      filter: ["!=", ["get", "hide_3d"], true],
    });
    expect(layerRegistrations().find((r) => r.id === CONTACT_LAYER_ID)).toMatchObject({
      slot: "area-overlays",
      order: 4.5,
    });
  });

  it("shows the contact shadow only with the extrusions", () => {
    fake.state.pitch = 0;
    render(<BuildingExtrusionLayer />);
    act(() => fake.emit("pitch"));
    expect(fake.state.layout.get(CONTACT_LAYER_ID)?.visibility).toBe("none");
    fake.state.pitch = 55;
    act(() => fake.emit("pitch"));
    expect(useBuildingsStore.getState().layerVisible).toBe(true);
    expect(fake.state.layout.get(CONTACT_LAYER_ID)?.visibility).toBe("visible");
  });

  it("keeps the contact shadow across a style reload", () => {
    render(<BuildingExtrusionLayer />);
    fake.state.layers.delete(CONTACT_LAYER_ID);
    act(() => {
      fake.emit("styledataloading");
      fake.emit("style.load");
    });
    expect(fake.state.layers.has(CONTACT_LAYER_ID)).toBe(true);
  });

  it("ignores the contact layer when resolving the building source and roof", () => {
    fake.state.layers.set(BUILDING_LAYER_ID, {
      ...(fake.state.layers.get(BUILDING_LAYER_ID) as object),
      paint: { "fill-color": "#e8e9ed" },
    } as never);
    render(<BuildingExtrusionLayer />);
    expect(fake.state.layers.has(CONTACT_LAYER_ID)).toBe(true);
    expect(findBuildingSourceReference(fake.map)).toEqual({
      source: "city",
      sourceLayer: "building",
    });
    expect(findBuildingRoofColor(fake.map, { source: "city", sourceLayer: "building" })).toBe(
      "#e8e9ed",
    );
  });

  it("leaves the scene light to the scene lighting", () => {
    render(<BuildingExtrusionLayer />);
    expect(fake.state.layers.has(LAYER_ID)).toBe(true);
    expect(fake.state.light).toBeNull();
  });

  it("hides buildings for navigation and restores the normal map selection", () => {
    render(<BuildingExtrusionLayer />);
    expect(useBuildingsStore.getState().layerVisible).toBe(true);
    act(() => useNavigationStore.setState({ status: "navigating" }));
    expect(useBuildingsStore.getState().layerVisible).toBe(false);
    fake.state.pitch = 55;
    act(() => fake.emit("pitch"));
    expect(fake.state.layout.get(LAYER_ID)?.visibility).toBe("none");
    act(() => useNavigationStore.setState({ status: "idle" }));
    expect(useBuildingsStore.getState().layerVisible).toBe(true);
  });

  it("preserves explicit navigation buildings through overview and remembers them for the next trip", () => {
    fake.state.pitch = 0;
    render(<BuildingExtrusionLayer />);
    act(() => useNavigationStore.setState({ status: "navigating" }));
    fake.state.pitch = 55;
    act(() => fake.emit("pitch"));
    expect(useBuildingsStore.getState().layerVisible).toBe(false);
    act(() => toggleOverlay("3d-buildings", { kind: "user" }));
    fake.state.pitch = 0;
    act(() => fake.emit("pitch"));
    expect(useBuildingsStore.getState().layerVisible).toBe(true);
    fake.state.pitch = 55;
    act(() => fake.emit("pitch"));
    expect(fake.state.layout.get(LAYER_ID)?.visibility).toBe("visible");
    act(() => useNavigationStore.setState({ status: "arrived" }));
    expect(useBuildingsStore.getState().layerVisible).toBe(true);
    act(() => useNavigationStore.setState({ status: "idle" }));
    expect(useBuildingsStore.getState().layerVisible).toBe(false);
    // The 3D view choice made during the drive is remembered for the next one.
    act(() => useNavigationStore.setState({ status: "navigating" }));
    expect(useBuildingsStore.getState().layerVisible).toBe(true);
    act(() => useNavigationStore.setState({ status: "idle" }));
  });

  describe("3D navigation choice", () => {
    afterEach(() => {
      act(() => useNavigationSceneStore.getState().setActive(false));
      useNavigationStore.setState({ mode: "driving" });
    });

    it("trip start keeps 3D on when navigation3d is on for driving", () => {
      useSettingsStore.setState({ navigation3d: true });
      render(<BuildingExtrusionLayer />);
      act(() => useNavigationStore.setState({ status: "navigating", mode: "driving" }));
      expect(useBuildingsStore.getState().layerVisible).toBe(true);
      expect(useBuildingsStore.getState().panelOpen).toBe(false);
      act(() => useNavigationStore.setState({ status: "idle" }));
    });

    it("trip start switches 3D off for walking even with navigation3d", () => {
      useSettingsStore.setState({ navigation3d: true });
      render(<BuildingExtrusionLayer />);
      act(() => useNavigationStore.setState({ status: "navigating", mode: "walking" }));
      expect(useBuildingsStore.getState().layerVisible).toBe(false);
      act(() => useNavigationStore.setState({ status: "idle" }));
    });

    it("turning 3D on mid-trip writes navigation3d and does not ease the pitch", () => {
      fake.state.pitch = 0;
      render(<BuildingExtrusionLayer />);
      act(() => useNavigationStore.setState({ status: "navigating", mode: "driving" }));
      fake.state.cameraTransitions.length = 0;
      act(() => toggleOverlay("3d-buildings", { kind: "user" }));
      expect(useSettingsStore.getState().navigation3d).toBe(true);
      expect(fake.state.cameraTransitions.filter((t) => "pitch" in t.options)).toEqual([]);
      act(() => toggleOverlay("3d-buildings", { kind: "user" }));
      expect(useSettingsStore.getState().navigation3d).toBe(false);
      act(() => useNavigationStore.setState({ status: "idle" }));
    });

    it("an automation change does not write navigation3d", () => {
      render(<BuildingExtrusionLayer />);
      act(() => useNavigationStore.setState({ status: "navigating", mode: "driving" }));
      act(() =>
        setOverlayLayerVisible("3d-buildings", true, { kind: "automation", owner: "test" }),
      );
      expect(useSettingsStore.getState().navigation3d).toBe(false);
      act(() => useNavigationStore.setState({ status: "idle" }));
    });

    it("navigation scene keeps the browsing z16.5–17 fade", () => {
      // An earlier fade in 3D navigation (from z15.5) kept the phone too busy
      // for a 30-minute drive, so navigation fades buildings in as browsing does.
      render(<BuildingExtrusionLayer />);
      act(() => useNavigationSceneStore.getState().setActive(true));
      const extrusion = fake.state.layers.get(LAYER_ID) as { minzoom?: number };
      const contact = fake.state.layers.get(CONTACT_LAYER_ID) as { minzoom?: number };
      expect(extrusion.minzoom).toBe(16.5);
      expect(contact.minzoom).toBe(16.5);
      expect(fake.state.paint.get(LAYER_ID)?.["fill-extrusion-opacity"]).toEqual([
        "interpolate",
        ["linear"],
        ["zoom"],
        16.5,
        0,
        17,
        1,
      ]);
    });
  });

  it("rebinds camera synchronization to a replacement map without resetting manual-off", () => {
    const { rerender } = render(<BuildingExtrusionLayer />);
    act(() => toggleOverlay("3d-buildings", { kind: "user" }));
    const oldMap = fake;
    fake = createFakeMap({ zoom: 17, pitch: 30 });
    mapRef.current = fake.map;
    addBaseStyle();
    styleVersion++;
    rerender(<BuildingExtrusionLayer />);
    act(() => fake.emit("pitch"));
    expect(useBuildingsStore.getState().layerVisible).toBe(false);
    fake.state.pitch = 0;
    act(() => fake.emit("pitch"));
    fake.state.pitch = 45;
    act(() => fake.emit("pitch"));
    expect(useBuildingsStore.getState().layerVisible).toBe(true);
    oldMap.state.pitch = 0;
    act(() => oldMap.emit("pitch"));
    expect(useBuildingsStore.getState().layerVisible).toBe(true);
  });

  it("preserves manual-off across a style reload", () => {
    const { rerender } = render(<BuildingExtrusionLayer />);
    act(() => toggleOverlay("3d-buildings", { kind: "user" }));
    styleVersion++;
    rerender(<BuildingExtrusionLayer />);
    fake.state.pitch = 55;
    act(() => fake.emit("pitch"));
    expect(useBuildingsStore.getState().layerVisible).toBe(false);
  });

  it("keeps flat buildings unobscured until the camera tilts", () => {
    fake.state.pitch = 0;
    render(<BuildingExtrusionLayer />);

    expect(fake.state.layers.get(LAYER_ID)?.layout).toHaveProperty("visibility", "none");
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
    expect(fake.state.layers.get(LAYER_ID)?.layout).toHaveProperty("visibility", "none");
  });

  it("enables the selector for an initially tilted camera", () => {
    render(<BuildingExtrusionLayer />);

    const layer = fake.state.layers.get(LAYER_ID);
    expect(useBuildingsStore.getState().panelOpen).toBe(true);
    expect(useBuildingsStore.getState().layerVisible).toBe(true);
    expect(manifest.frontend.overlay.minZoom).toBe(layer?.minzoom);
    expect(layer?.source).toBe("city");
    expect(layer?.["source-layer"]).toBe("building");
    expect(layer?.type).toBe("fill-extrusion");
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
    expect(fake.state.cameraTransitions.at(-1)).toMatchObject({
      method: "easeTo",
      options: { pitch: 45 },
      eventData: { programmatic: true },
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
      eventData: { programmatic: true },
    });
    expect(fake.state.cameraTransitions.some((transition) => transition.method === "easeTo")).toBe(
      false,
    );
  });

  it("does not restore an obsolete selection when a delayed idle arrives", () => {
    render(<BuildingExtrusionLayer />);
    fake.state.styleLoaded = false;
    const parsedStyle = fake.map.getStyle();
    vi.spyOn(fake.map, "getStyle").mockImplementation(() =>
      fake.state.styleLoaded ? parsedStyle : (undefined as never),
    );
    // A replacement stylesheet announces itself before it stops being parsed.
    act(() => {
      fake.emit("styledataloading");
      fake.emit("styledata");
    });

    // Parsing finishes before React handles the user's off choice, but the old
    // style callback is still waiting for the later idle event.
    fake.state.styleLoaded = true;
    act(() => toggleOverlay("3d-buildings", { kind: "user" }));
    act(() => fake.emit("idle"));

    expect(useBuildingsStore.getState().layerVisible).toBe(false);
    expect(fake.state.layout.get(LAYER_ID)?.visibility).toBe("none");
    expect(fake.state.pitch).toBe(20);
  });

  it("hides existing buildings immediately even while tiles are loading", () => {
    render(<BuildingExtrusionLayer />);
    fake.state.styleLoaded = false;
    act(() => toggleOverlay("3d-buildings", { kind: "user" }));
    expect(fake.state.layout.get(LAYER_ID)?.visibility).toBe("none");

    act(() => {
      fake.emit("styledata");
      fake.emit("styledata");
    });
    expect(fake.state.handlers.get("idle")?.size ?? 0).toBe(0);
    expect(fake.state.handlers.get("render")?.size ?? 0).toBe(0);
    fake.state.styleLoaded = true;
    act(() => fake.emit("idle"));
    expect(fake.state.layout.get(LAYER_ID)?.visibility).toBe("none");
    expect(fake.state.handlers.get("idle")?.size ?? 0).toBe(0);
  });

  it("cannot recreate buildings from a pending callback after unmount", () => {
    const { unmount } = render(<BuildingExtrusionLayer />);
    fake.state.styleLoaded = false;
    const parsedStyle = fake.map.getStyle();
    vi.spyOn(fake.map, "getStyle").mockImplementation(() =>
      fake.state.styleLoaded ? parsedStyle : (undefined as never),
    );
    // A replacement stylesheet announces itself before it stops being parsed.
    act(() => {
      fake.emit("styledataloading");
      fake.emit("styledata");
    });
    unmount();
    fake.state.layers.delete(LAYER_ID);
    fake.state.styleLoaded = true;
    act(() => fake.emit("idle"));
    expect(fake.state.layers.has(LAYER_ID)).toBe(false);
    expect(fake.state.handlers.get("idle")?.size ?? 0).toBe(0);
  });
});

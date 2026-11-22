import { getOverlayEntry, registerOverlayEntry } from "@openmapx/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useBuildingsStore } from "../store";

if (!getOverlayEntry("3d-buildings")) {
  registerOverlayEntry({
    id: "3d-buildings",
    getState: () => useBuildingsStore.getState(),
    useActive: () => useBuildingsStore((s) => s.panelOpen && s.layerVisible),
    excludes: [],
  });
}

const reset = () =>
  useBuildingsStore.setState({
    panelOpen: false,
    layerVisible: false,
    navigationPreference: null,
    cameraAutoEnableBlocked: false,
  });

describe("buildings navigation sync", () => {
  beforeEach(reset);
  afterEach(reset);

  it("trip start keeps 3D on when the driver chose 3D navigation", () => {
    useBuildingsStore.getState().syncNavigation(true, { show3d: true });
    expect(useBuildingsStore.getState().layerVisible).toBe(true);
  });

  it("trip start switches 3D off without the 3D navigation choice", () => {
    useBuildingsStore.setState({ panelOpen: true, layerVisible: true });
    useBuildingsStore.getState().syncNavigation(true, { show3d: false });
    expect(useBuildingsStore.getState().layerVisible).toBe(false);
  });

  it("trip start does not open the panel", () => {
    useBuildingsStore.setState({ panelOpen: true, layerVisible: false });
    useBuildingsStore.getState().syncNavigation(true, { show3d: true });
    expect(useBuildingsStore.getState().panelOpen).toBe(false);
    expect(useBuildingsStore.getState().layerVisible).toBe(true);
  });

  it("trip end restores the pre-trip state", () => {
    useBuildingsStore.setState({ panelOpen: true, layerVisible: false });
    useBuildingsStore.getState().syncNavigation(true, { show3d: true });
    useBuildingsStore.getState().syncNavigation(false);
    expect(useBuildingsStore.getState()).toMatchObject({ panelOpen: true, layerVisible: false });
  });
});

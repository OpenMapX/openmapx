// @vitest-environment jsdom

import {
  createOverlayStore,
  getRegisteredOverlayStore,
  isOverlayActive,
  type OverlayStoreBase,
  registerOverlayEntry,
  runOverlayTransaction,
  useLayerStore,
} from "@openmapx/core";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { toggleGlobeLighting, useGlobeLightingActive } from "./globeLighting";

const FALLBACK: OverlayStoreBase = {
  panelOpen: false,
  layerVisible: false,
  userRevision: 0,
  openPanel: () => {},
  closePanel: () => {},
  setLayerVisible: () => {},
};

function openSunTime(open: boolean) {
  act(() => {
    runOverlayTransaction("sun-time", { panelOpen: open }, { kind: "user" });
  });
}

beforeAll(() => {
  createOverlayStore({ overlayId: "sun-time", extra: {} });
  registerOverlayEntry({
    id: "sun-time",
    getState: () => getRegisteredOverlayStore("sun-time")?.getState() ?? FALLBACK,
    useActive: () => false,
    excludes: [],
  });
});

afterEach(() => {
  openSunTime(false);
  act(() => useLayerStore.getState().setGlobeLighting(true));
});

describe("globe day and night versus the Daylight & time zones overlay", () => {
  it("suspends the globe's lighting while the overlay is open, keeping the preference", () => {
    const { result } = renderHook(() => useGlobeLightingActive());
    expect(result.current).toBe(true);

    openSunTime(true);
    expect(result.current).toBe(false);
    expect(useLayerStore.getState().globeLighting).toBe(true);

    openSunTime(false);
    expect(result.current).toBe(true);
  });

  it("turns the lighting off when it shows", () => {
    act(() => toggleGlobeLighting());
    expect(useLayerStore.getState().globeLighting).toBe(false);
  });

  it("closes the overlay when day and night is chosen while it is open", () => {
    const { result } = renderHook(() => useGlobeLightingActive());
    openSunTime(true);
    act(() => toggleGlobeLighting());
    expect(isOverlayActive("sun-time")).toBe(false);
    expect(useLayerStore.getState().globeLighting).toBe(true);
    expect(result.current).toBe(true);
  });

  it("turns a stored 'off' back on when chosen while the overlay is open", () => {
    act(() => useLayerStore.getState().setGlobeLighting(false));
    openSunTime(true);
    act(() => toggleGlobeLighting());
    expect(isOverlayActive("sun-time")).toBe(false);
    expect(useLayerStore.getState().globeLighting).toBe(true);
  });
});

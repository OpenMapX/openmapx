import { describe, expect, it, vi } from "vitest";
import { createOverlayStore, subscribeOverlayStoreChanges } from "../createOverlayStore";
import {
  initOverlayRegistry,
  isOverlayRegistryInitialized,
  registerOverlayEntry,
} from "../overlayRegistry";

describe("overlay registry readiness", () => {
  it("is uninitialized until initOverlayRegistry runs, then notifies overlay subscribers", () => {
    expect(isOverlayRegistryInitialized()).toBe(false);

    const listener = vi.fn();
    const unsubscribe = subscribeOverlayStoreChanges(listener);
    initOverlayRegistry([]);
    unsubscribe();

    expect(isOverlayRegistryInitialized()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("notifies overlay subscribers when an entry is registered at runtime", () => {
    createOverlayStore({ overlayId: "readiness-runtime-entry", extra: {} });
    const listener = vi.fn();
    const unsubscribe = subscribeOverlayStoreChanges(listener);
    registerOverlayEntry({
      id: "readiness-runtime-entry",
      getState: () => ({
        panelOpen: false,
        layerVisible: false,
        userRevision: 0,
        openPanel: () => {},
        closePanel: () => {},
        setLayerVisible: () => {},
      }),
      useActive: () => false,
      excludes: [],
    });
    unsubscribe();

    expect(listener).toHaveBeenCalledTimes(1);
  });
});

// @vitest-environment jsdom

import {
  createOverlayStore,
  getRegisteredOverlayStore,
  registerOverlayEntry,
  toggleOverlay,
} from "@openmapx/core";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useAnyOverlayPanelOpen, useOverlayPanelOpen } from "./useOverlayStoreState";

// The overlay store registry is module-global and stores cannot be
// unregistered, so every test uses its own unique overlay id.
let seq = 0;
function nextId(): string {
  seq += 1;
  return `test-overlay-${seq}`;
}

describe("useOverlayStoreState hooks under store replacement", () => {
  it("useAnyOverlayPanelOpen observes a store registered after mount", () => {
    const id = nextId();
    const { result } = renderHook(() => useAnyOverlayPanelOpen([id]));
    expect(result.current).toBe(false);

    let store: ReturnType<typeof createOverlayStore> | undefined;
    act(() => {
      store = createOverlayStore({ overlayId: id, extra: {} });
      store.getState().openPanel();
    });
    expect(result.current).toBe(true);
  });

  it("useAnyOverlayPanelOpen observes toggles on a REPLACEMENT store instance", () => {
    const id = nextId();
    // Instance A: what initOverlayRegistry (or an early lookup) auto-creates
    // before the hook mounts.
    createOverlayStore({ overlayId: id, extra: {} });

    const { result } = renderHook(() => useAnyOverlayPanelOpen([id]));
    expect(result.current).toBe(false);

    // Instance B: a lazy-loaded map-layer chunk's module-scope
    // createOverlayStore call replaces A in the registry after first render.
    let replacement: ReturnType<typeof createOverlayStore> | undefined;
    act(() => {
      replacement = createOverlayStore({ overlayId: id, extra: {} });
    });

    // Enabling the layer mutates the CURRENT (replacement) instance — this is
    // the notification that regressed when the hook subscribed to instance A.
    act(() => {
      replacement?.getState().openPanel();
    });
    expect(result.current).toBe(true);

    act(() => {
      replacement?.getState().closePanel();
    });
    expect(result.current).toBe(false);
  });

  it("useOverlayPanelOpen observes toggles on a replacement store instance", () => {
    const id = nextId();
    createOverlayStore({ overlayId: id, extra: {} });

    const { result } = renderHook(() => useOverlayPanelOpen(id));
    expect(result.current).toBe(false);

    let replacement: ReturnType<typeof createOverlayStore> | undefined;
    act(() => {
      replacement = createOverlayStore({ overlayId: id, extra: {} });
    });
    act(() => {
      replacement?.getState().openPanel();
    });
    expect(result.current).toBe(true);
  });

  it("useAnyOverlayPanelOpen reflects toggleOverlay through the registry entry", () => {
    const id = nextId();
    createOverlayStore({ overlayId: id, extra: {} });

    // Mirror the dynamic-lookup entry initOverlayRegistry builds — the exact
    // path the layer selector's toggleOverlay call goes through.
    registerOverlayEntry({
      id,
      getState: () =>
        getRegisteredOverlayStore(id)?.getState() ?? {
          panelOpen: false,
          layerVisible: false,
          userRevision: 0,
          openPanel: () => {},
          closePanel: () => {},
          setLayerVisible: () => {},
        },
      useActive: () => false,
      excludes: [],
    });

    const { result } = renderHook(() => useAnyOverlayPanelOpen([id]));
    expect(result.current).toBe(false);

    // Replace the instance (lazy map-layer chunk load), then toggle via the
    // registry as the layer selector does. The toggle mutates the replacement.
    act(() => {
      createOverlayStore({ overlayId: id, extra: {} });
    });
    act(() => {
      toggleOverlay(id, { kind: "user" });
    });
    expect(result.current).toBe(true);

    act(() => {
      toggleOverlay(id, { kind: "user" });
    });
    expect(result.current).toBe(false);
  });
});

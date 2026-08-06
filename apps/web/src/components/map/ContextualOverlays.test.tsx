// @vitest-environment jsdom

import {
  createOverlayStore,
  getOverlayEntry,
  getRegisteredOverlayStore,
  type OverlayStoreBase,
  registerOverlayEntry,
  useDirectionsStore,
  useNavigationStore,
} from "@openmapx/core";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ContextualOverlays } from "./ContextualOverlays";

/**
 * Registers a fresh store + registry entry for one of the ids
 * ContextualOverlays' own CONTEXTUAL_OVERLAYS table names. registerOverlayEntry
 * dedups by id and entries can't be unregistered, so this only needs to run
 * once per id for the whole file — re-running createOverlayStore for the same
 * id between tests resets that overlay back to a fresh (closed, revision 0)
 * store without touching the registry entry (whose getState() already
 * resolves the current instance dynamically).
 */
const UNREGISTERED_FALLBACK: OverlayStoreBase = {
  panelOpen: false,
  layerVisible: false,
  userRevision: 0,
  openPanel: () => {},
  closePanel: () => {},
  setLayerVisible: () => {},
};

function resetOverlay(id: string, excludes: string[] = []): void {
  createOverlayStore({ overlayId: id, extra: {} });
  registerOverlayEntry({
    id,
    getState: () => getRegisteredOverlayStore(id)?.getState() ?? UNREGISTERED_FALLBACK,
    useActive: () => false,
    excludes,
  });
}

function overlayState(id: string) {
  const entry = getOverlayEntry(id);
  if (!entry) throw new Error(`overlay ${id} not registered`);
  return entry.getState();
}

function isActive(id: string): boolean {
  const state = overlayState(id);
  return state.panelOpen && state.layerVisible;
}

beforeEach(() => {
  // "road-conditions" is deliberately left unregistered here — it stands in
  // for an overlay integration that isn't deployed, exercising the
  // getOverlayEntry guard every test implicitly.
  resetOverlay("traffic-flow", ["traffic"]);
  resetOverlay("traffic", ["traffic-flow"]);
  resetOverlay("live-transit");
  resetOverlay("transit");
  useDirectionsStore.setState({ isOpen: false, mode: "driving" });
  useNavigationStore.setState({ status: "idle", kind: "ground", mode: "driving" });
});

afterEach(() => {
  cleanup();
  useDirectionsStore.setState({ isOpen: false, mode: "driving" });
  useNavigationStore.setState({ status: "idle", kind: "ground", mode: "driving" });
});

describe("ContextualOverlays", () => {
  it("displaces a pre-enabled exclusion peer and restores it on context exit", () => {
    act(() => overlayState("traffic").openPanel());
    expect(isActive("traffic")).toBe(true);

    render(<ContextualOverlays />);
    act(() => {
      useDirectionsStore.getState().open();
      useDirectionsStore.getState().setMode("driving");
    });

    expect(isActive("traffic-flow")).toBe(true);
    expect(isActive("traffic")).toBe(false);

    act(() => useDirectionsStore.getState().close());

    expect(isActive("traffic-flow")).toBe(false);
    expect(isActive("traffic")).toBe(true);
  });

  it("does not throw and still drives the registered overlay when a peer integration is missing", () => {
    expect(getOverlayEntry("road-conditions")).toBeUndefined();
    render(<ContextualOverlays />);
    expect(() => {
      act(() => {
        useDirectionsStore.getState().open();
        useDirectionsStore.getState().setMode("driving");
      });
    }).not.toThrow();
    expect(isActive("traffic-flow")).toBe(true);
  });

  it("leaves a user's mid-context disable alone: it stays off and exit does not re-toggle it", () => {
    render(<ContextualOverlays />);
    act(() => {
      useDirectionsStore.getState().open();
      useDirectionsStore.getState().setMode("driving");
    });
    expect(isActive("traffic-flow")).toBe(true);

    // A direct closePanel() call is what the layer selector's toggleOverlay
    // ultimately does — user intent by construction.
    act(() => overlayState("traffic-flow").closePanel());
    expect(isActive("traffic-flow")).toBe(false);

    act(() => useDirectionsStore.getState().close());
    expect(isActive("traffic-flow")).toBe(false);
  });

  it("a user re-setting the same value automation already set still counts as user intent and wins at exit", () => {
    render(<ContextualOverlays />);
    act(() => {
      useDirectionsStore.getState().open();
      useDirectionsStore.getState().setMode("driving");
    });
    expect(isActive("traffic-flow")).toBe(true);

    // Direct call, not through the automation transaction — bumps userRevision
    // even though the visible value doesn't change.
    act(() => overlayState("traffic-flow").openPanel());

    act(() => useDirectionsStore.getState().close());
    expect(isActive("traffic-flow")).toBe(true);
  });

  it("keeps ownership across a driving-planning -> driving-nav transition instead of releasing and reacquiring", () => {
    act(() => overlayState("traffic").openPanel());

    render(<ContextualOverlays />);
    act(() => {
      useDirectionsStore.getState().open();
      useDirectionsStore.getState().setMode("driving");
    });
    expect(isActive("traffic-flow")).toBe(true);
    expect(isActive("traffic")).toBe(false);

    // Both contexts true in the same update: a plausible transition where the
    // directions panel is still open as navigation starts.
    act(() => {
      useNavigationStore.setState({ status: "navigating", kind: "ground", mode: "driving" });
    });
    expect(isActive("traffic-flow")).toBe(true);
    expect(isActive("traffic")).toBe(false);

    // Now only driving-nav remains active.
    act(() => useDirectionsStore.getState().close());
    expect(isActive("traffic-flow")).toBe(true);
    expect(isActive("traffic")).toBe(false);

    // Exiting the last active context finally restores the displaced peer.
    act(() => {
      useNavigationStore.setState({ status: "idle", kind: "ground", mode: "driving" });
    });
    expect(isActive("traffic-flow")).toBe(false);
    expect(isActive("traffic")).toBe(true);
  });

  it("enables traffic-flow for driving-nav even without the directions panel open (route-specific flow during navigation)", () => {
    render(<ContextualOverlays />);
    act(() => {
      useNavigationStore.setState({ status: "navigating", kind: "ground", mode: "driving" });
    });
    expect(isActive("traffic-flow")).toBe(true);
  });

  it("stops contextual automation on arrival (isLiveNavigationStatus excludes 'arrived')", () => {
    render(<ContextualOverlays />);
    act(() => {
      useNavigationStore.setState({ status: "navigating", kind: "ground", mode: "driving" });
    });
    expect(isActive("traffic-flow")).toBe(true);

    act(() => {
      useNavigationStore.setState({ status: "arrived" });
    });
    expect(isActive("traffic-flow")).toBe(false);
  });

  it("restores prior state on unmount mid-context", () => {
    act(() => overlayState("traffic").openPanel());

    const view = render(<ContextualOverlays />);
    act(() => {
      useDirectionsStore.getState().open();
      useDirectionsStore.getState().setMode("driving");
    });
    expect(isActive("traffic-flow")).toBe(true);
    expect(isActive("traffic")).toBe(false);

    act(() => view.unmount());

    expect(isActive("traffic-flow")).toBe(false);
    expect(isActive("traffic")).toBe(true);
  });

  it("transit contexts enable transit overlays and leave driving overlays untouched", () => {
    render(<ContextualOverlays />);
    act(() => {
      useDirectionsStore.getState().open();
      useDirectionsStore.getState().setMode("transit");
    });

    expect(isActive("live-transit")).toBe(true);
    expect(isActive("transit")).toBe(true);
    expect(isActive("traffic-flow")).toBe(false);
    expect(isActive("traffic")).toBe(false);

    act(() => useDirectionsStore.getState().close());
    expect(isActive("live-transit")).toBe(false);
    expect(isActive("transit")).toBe(false);
  });
});

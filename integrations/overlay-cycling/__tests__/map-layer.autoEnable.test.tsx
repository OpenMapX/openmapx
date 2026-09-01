// @vitest-environment jsdom

import { getOverlayEntry, registerOverlayEntry, useDirectionsStore } from "@openmapx/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@/test";

vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ mapRef: { current: null }, mapReady: false, styleVersion: 0 }),
}));

import { CyclingLayer } from "../map-layer";
import { useCyclingStore } from "../store";

// runOverlayTransaction resolves "cycling" through the overlay registry, not
// the store directly — in the real app that entry comes from
// initOverlayRegistry (IntegrationProvider, run once the integration
// manifests are fetched, always before a lazy-loaded map-layer chunk like
// this one can mount). Reproduce that wiring here instead of relying on the
// direct-store-call behavior this test is guarding against regressing to.
if (!getOverlayEntry("cycling")) {
  registerOverlayEntry({
    id: "cycling",
    getState: () => useCyclingStore.getState(),
    useActive: () => useCyclingStore((s) => s.panelOpen && s.layerVisible),
    excludes: [],
  });
}

function resetStores(): void {
  useCyclingStore.setState({
    panelOpen: false,
    layerVisible: false,
    autoEnabled: false,
    userRevision: 0,
  });
  useDirectionsStore.setState({ isOpen: false, mode: "driving" });
}

function isCyclingActive(): boolean {
  const s = useCyclingStore.getState();
  return s.panelOpen && s.layerVisible;
}

beforeEach(resetStores);
afterEach(resetStores);

describe("CyclingLayer auto-enable (contextual automation)", () => {
  it("enables through an automation-origin transaction — userRevision stays unbumped — when entering cycling directions mode", () => {
    render(<CyclingLayer />);
    act(() => {
      useDirectionsStore.getState().open();
      useDirectionsStore.getState().setMode("cycling");
    });

    expect(isCyclingActive()).toBe(true);
    expect(useCyclingStore.getState().autoEnabled).toBe(true);
    // The transaction is tagged "automation", not "user" — a real user
    // toggle elsewhere must still be able to tell this apart later.
    expect(useCyclingStore.getState().userRevision).toBe(0);
  });

  it("disables when directions mode changes away from cycling", () => {
    render(<CyclingLayer />);
    act(() => {
      useDirectionsStore.getState().open();
      useDirectionsStore.getState().setMode("cycling");
    });
    expect(isCyclingActive()).toBe(true);

    act(() => useDirectionsStore.getState().setMode("driving"));
    expect(isCyclingActive()).toBe(false);
    expect(useCyclingStore.getState().autoEnabled).toBe(false);
  });

  it("disables when the directions panel closes while auto-enabled", () => {
    render(<CyclingLayer />);
    act(() => {
      useDirectionsStore.getState().open();
      useDirectionsStore.getState().setMode("cycling");
    });
    expect(isCyclingActive()).toBe(true);

    act(() => useDirectionsStore.getState().close());
    expect(isCyclingActive()).toBe(false);
  });

  it("does not auto-disable an overlay the user enabled themselves outside cycling mode", () => {
    // Direct call — the same thing a legend checkbox would do.
    act(() => useCyclingStore.getState().openPanel());
    expect(isCyclingActive()).toBe(true);

    render(<CyclingLayer />);
    act(() => {
      useDirectionsStore.getState().open();
      useDirectionsStore.getState().setMode("driving");
    });
    // autoEnabled was never set for this "on" state, so the mode-change
    // branch (which only closes when store.autoEnabled is true) leaves it.
    expect(isCyclingActive()).toBe(true);
  });
});

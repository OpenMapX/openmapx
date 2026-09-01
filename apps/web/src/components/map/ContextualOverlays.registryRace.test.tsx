// @vitest-environment jsdom

/**
 * A deep link can open transit directions before IntegrationProvider has
 * populated the overlay registry. The contextual automation must pick those
 * overlays up once the registry initializes instead of skipping them for the
 * rest of the session. Separate file so the registry starts uninitialized.
 */
import {
  createOverlayStore,
  getOverlayEntry,
  initOverlayRegistry,
  useDirectionsStore,
  useNavigationStore,
} from "@openmapx/core";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ContextualOverlays } from "./ContextualOverlays";

type IntegrationMeta = Parameters<typeof initOverlayRegistry>[0][number];

function meta(id: string): IntegrationMeta {
  return { id, name: id, enabled: true, domains: ["map-overlay"], frontend: { overlay: {} } };
}

function isActive(id: string): boolean {
  const entry = getOverlayEntry(id);
  if (!entry) throw new Error(`overlay ${id} not registered`);
  const state = entry.getState();
  return state.panelOpen && state.layerVisible;
}

beforeEach(() => {
  createOverlayStore({ overlayId: "transit", extra: {} });
  createOverlayStore({ overlayId: "live-transit", extra: {} });
  useNavigationStore.setState({ status: "idle", kind: "ground", mode: "driving" });
});

afterEach(() => {
  cleanup();
  useDirectionsStore.setState({ isOpen: false, mode: "driving" });
});

describe("ContextualOverlays before the overlay registry is initialized", () => {
  it("enables the context's overlays once the registry initializes", () => {
    // What a deep link does at map-ready time, before /api/integrations resolves.
    useDirectionsStore.setState({ isOpen: true, mode: "transit" });
    render(<ContextualOverlays />);
    expect(getOverlayEntry("transit")).toBeUndefined();

    act(() => initOverlayRegistry([meta("overlay-transit"), meta("overlay-live-transit")]));

    expect(isActive("transit")).toBe(true);
    expect(isActive("live-transit")).toBe(true);

    act(() => useDirectionsStore.getState().close());
    expect(isActive("transit")).toBe(false);
    expect(isActive("live-transit")).toBe(false);
  });
});

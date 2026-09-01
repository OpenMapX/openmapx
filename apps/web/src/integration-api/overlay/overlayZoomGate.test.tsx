// @vitest-environment jsdom

import { useMapStore } from "@openmapx/core";
import { IntegrationRegistry } from "@openmapx/integration-framework";
import { IntegrationRegistryContext } from "@openmapx/integration-framework/react";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { useOverlayMinZoom, useOverlayZoomGate } from "./overlayZoomGate";

/** Two overlays: one gated at z7, one that declares no threshold. */
const registry = new IntegrationRegistry([
  {
    id: "road-conditions",
    name: "Road conditions",
    enabled: true,
    domains: ["map-overlay"],
    isBuiltIn: true,
    frontend: { overlay: { minZoom: 7 } },
  },
  {
    id: "overlay-earthquakes",
    name: "Earthquakes",
    enabled: true,
    domains: ["map-overlay"],
    isBuiltIn: true,
    frontend: { overlay: {} },
  },
]);

const wrapper = ({ children }: { children: ReactNode }) => (
  <IntegrationRegistryContext.Provider value={registry}>
    {children}
  </IntegrationRegistryContext.Provider>
);

function setZoom(zoom: number) {
  act(() => {
    useMapStore.getState().setZoom(zoom);
  });
}

describe("overlay zoom gate", () => {
  beforeEach(() => {
    setZoom(2);
  });

  it("reads the threshold from the integration manifest, keyed by overlay id", () => {
    // `overlay-` prefix stripped: overlay-earthquakes -> earthquakes.
    const { result } = renderHook(() => useOverlayMinZoom("road-conditions"), { wrapper });
    expect(result.current).toBe(7);

    const none = renderHook(() => useOverlayMinZoom("earthquakes"), { wrapper });
    expect(none.result.current).toBe(0);
  });

  it("reports 0 for an overlay the registry doesn't know", () => {
    const { result } = renderHook(() => useOverlayMinZoom("does-not-exist"), { wrapper });
    expect(result.current).toBe(0);
  });

  it("gates below the threshold and clears at or above it", () => {
    const { result } = renderHook(() => useOverlayZoomGate("road-conditions"), { wrapper });

    // Country-sized view — the case that made the overlay stutter.
    expect(result.current.belowMinZoom).toBe(true);
    expect(result.current.minZoom).toBe(7);

    setZoom(6.9);
    expect(result.current.belowMinZoom).toBe(true);

    // A German state fits around z7 and must stay usable.
    setZoom(7);
    expect(result.current.belowMinZoom).toBe(false);

    setZoom(12);
    expect(result.current.belowMinZoom).toBe(false);
  });

  it("never gates an overlay without a declared threshold, even at world zoom", () => {
    const { result } = renderHook(() => useOverlayZoomGate("earthquakes"), { wrapper });
    setZoom(0);
    expect(result.current.belowMinZoom).toBe(false);
  });
});

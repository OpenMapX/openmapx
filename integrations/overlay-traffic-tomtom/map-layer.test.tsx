// @vitest-environment jsdom
import { useMapStore } from "@openmapx/core";
import { IntegrationRegistry } from "@openmapx/integration-framework";
import { IntegrationRegistryContext } from "@openmapx/integration-framework/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { useOverlayZoomGate } from "@/integration-api/overlay/overlayZoomGate";
import { EnvProvider } from "@/integration-api/runtime/EnvProvider";
import { buildClientEnv } from "@/integration-api/runtime/env";
import { render, renderHook } from "@/test";
import manifest from "./manifest.json";
import { TrafficLayer } from "./map-layer";

const state = vi.hoisted(() => ({ layer: undefined as { minzoom: number } | undefined }));
vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ mapRef: { current: null }, mapReady: true, styleVersion: 0 }),
}));
vi.mock("@/integration-api/map/useStyleSyncedLayer", () => ({
  useStyleSyncedLayer: (options: { addLayer: (map: unknown) => void }) => {
    options.addLayer({});
  },
}));
vi.mock("@/integration-api/map/layerStack", () => ({
  addLayerInSlot: (_map: unknown, layer: { minzoom: number }) => {
    state.layer = layer;
  },
}));
vi.mock("@/integration-api/overlay/useContributorResolver", () => ({
  useContributorResolver: () => () => [],
}));
vi.mock("@/integration-api/overlay/useRasterMapAttributions", () => ({
  useRasterMapAttributions: () => {},
}));
const registry = new IntegrationRegistry([
  { ...manifest, isBuiltIn: true, enabled: true },
  {
    id: "overlay-traffic-flow",
    name: "Vector flow",
    enabled: true,
    isBuiltIn: true,
    domains: ["map-overlay"],
    frontend: { overlay: { minZoom: 6 } },
  },
]);
describe("raster layer and selector share the managed zoom gate", () => {
  it.each([
    ["8", 8, false],
    ["garbage", 10, true],
    [undefined, 10, true],
  ] as const)("uses %s consistently", (value, expected, blocked) => {
    useMapStore.getState().setZoom(8);
    const config = buildClientEnv(undefined, { NEXT_PUBLIC_TRAFFIC_MIN_ZOOM: value });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <IntegrationRegistryContext.Provider value={registry}>
        <EnvProvider config={config}>{children}</EnvProvider>
      </IntegrationRegistryContext.Provider>
    );
    render(<TrafficLayer />, { wrapper });
    expect(state.layer?.minzoom).toBe(expected);
    expect(renderHook(() => useOverlayZoomGate("traffic"), { wrapper }).result.current).toEqual({
      minZoom: expected,
      belowMinZoom: blocked,
    });
    expect(
      renderHook(() => useOverlayZoomGate("traffic-flow"), { wrapper }).result.current.minZoom,
    ).toBe(6);
  });
});

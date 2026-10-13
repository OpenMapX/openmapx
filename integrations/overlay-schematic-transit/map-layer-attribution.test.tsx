import { IntegrationRegistry } from "@openmapx/integration-framework";
import { IntegrationRegistryContext } from "@openmapx/integration-framework/react";
import type { MapGeoJSONFeature } from "maplibre-gl";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMapAttributionStore } from "@/integration-api/overlay/mapAttributionStore";
import { act, createFakeMap, type FakeMap, render } from "@/test";
import manifest from "./manifest.json";
import { useSchematicTransitStore } from "./store";

let fake: FakeMap;
const mapRef = {
  get current() {
    return fake.map;
  },
};
vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ mapRef, mapReady: true, styleVersion: 0 }),
}));
vi.mock("@/integration-api/runtime/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: "https://api.test" }),
}));

import { SchematicTransitLayer } from "./map-layer";

const registry = new IntegrationRegistry([
  {
    id: "overlay-schematic-transit",
    name: "LOOM",
    enabled: true,
    isBuiltIn: true,
    domains: ["map-overlay"],
    dataSources: manifest.dataSources,
  },
]);
const wrapper = ({ children }: { children: ReactNode }) => (
  <IntegrationRegistryContext.Provider value={registry}>
    {children}
  </IntegrationRegistryContext.Provider>
);
const hit = {
  type: "Feature",
  geometry: {
    type: "LineString",
    coordinates: [
      [0, 0],
      [1, 1],
    ],
  },
  properties: { "line-color": "FF3300", width: "2" },
} as unknown as MapGeoJSONFeature;
const flush = () =>
  act(() => {
    fake.emit("render");
    vi.advanceTimersByTime(250);
  });
const html = () => Object.values(useMapAttributionStore.getState().byLayer).flat().join(" ");
beforeEach(() => {
  vi.useFakeTimers();
  fake = createFakeMap({ zoom: 18 });
  useSchematicTransitStore.setState({ layerVisible: true });
  useMapAttributionStore.setState({ byLayer: {} });
});
afterEach(() => {
  act(() => useSchematicTransitStore.setState({ layerVisible: false }));
  vi.useRealTimers();
});
describe("LOOM geometry receipt", () => {
  it("credits rendered overzoomed lines and clears when the viewport is empty", () => {
    render(<SchematicTransitLayer />, { wrapper });
    fake.setRenderedFeatures("omx-schematic-transit-lines", [hit]);
    flush();
    expect(html()).toContain("LOOM");
    fake.setRenderedFeatures("omx-schematic-transit-lines", []);
    flush();
    expect(html()).toBe("");
  });
  it("does not credit enabled LOOM before any geometry is rendered", () => {
    render(<SchematicTransitLayer />, { wrapper });
    flush();
    expect(html()).toBe("");
  });
});

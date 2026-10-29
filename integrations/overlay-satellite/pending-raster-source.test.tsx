import { SatelliteLayer } from "@integrations/overlay-satellite/map-layer";
import { useSatelliteStore } from "@integrations/overlay-satellite/store";
import { WinterSportsLayer } from "@integrations/overlay-winter-sports/map-layer";
import { useWinterSportsStore } from "@integrations/overlay-winter-sports/store";
import { expect, it, vi } from "vitest";
import { createFakeMap, render } from "@/test";

let fake = createFakeMap({ styleLoaded: false });
const ref = {
  get current() {
    return fake.map;
  },
};
vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ mapRef: ref, mapReady: true, styleVersion: 0 }),
}));
vi.mock("@/integration-api/runtime/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: "https://api.example.test" }),
}));
vi.mock("@/integration-api/overlay/useContributorResolver", () => ({
  useContributorResolver: () => () => [],
}));
vi.mock("@/integration-api/overlay/useRasterMapAttributions", () => ({
  useRasterMapAttributions: () => {},
}));
vi.mock("@/integration-api/overlay/useRenderedMapAttributions", () => ({
  useRenderedMapAttributions: () => {},
}));
it.each([
  {
    name: "satellite",
    Component: SatelliteLayer,
    enable: () => useSatelliteStore.setState({ layerVisible: true }),
    disable: () => useSatelliteStore.setState({ layerVisible: false }),
    layer: "openmapx-satellite-gibs-layer",
  },
  {
    name: "winter",
    Component: WinterSportsLayer,
    enable: () => useWinterSportsStore.setState({ layerVisible: true }),
    disable: () => useWinterSportsStore.setState({ layerVisible: false }),
    layer: "openmapx-opensnowmap-layer",
  },
])(
  "mounts $name without waiting for unrelated pending sources or leaving an idle callback after unmount",
  ({ Component, enable, disable, layer }) => {
    fake = createFakeMap({ styleLoaded: false, zoom: 8 });
    Object.assign(fake.map, { triggerRepaint: vi.fn() });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({})),
    );
    enable();
    const view = render(<Component />);
    try {
      expect(fake.state.layers.has(layer)).toBe(true);
      view.unmount();
      const count = new Map(fake.state.counts.addLayer);
      fake.state.layers.clear();
      fake.state.styleLoaded = true;
      fake.emit("idle");
      expect(fake.state.counts.addLayer).toEqual(count);
    } finally {
      view.unmount();
      disable();
      vi.unstubAllGlobals();
    }
  },
);

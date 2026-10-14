import { useLayerStore } from "@openmapx/core";
import { act, render } from "@testing-library/react";
import type { Map as MapLibreMap } from "maplibre-gl";
import { expect, it, vi } from "vitest";
import { useMapAttributionStore } from "@/integration-api/overlay/mapAttributionStore";
import { createFakeMap } from "@/test";
import { RasterBaseLayer } from "./RasterBaseLayer";

const fake = createFakeMap();
vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ mapRef: { current: fake.map }, mapReady: true, styleVersion: 0 }),
}));
it("credits base raster only after retained content is painted, including overzoom and failures", () => {
  vi.useFakeTimers();
  let texture: object | undefined;
  let opacity = 1;
  let visible = true;
  Object.defineProperty(fake.map, "style", {
    configurable: true,
    value: {
      tileManagers: {
        base: {
          getVisibleCoordinates: () => (visible ? [{ key: "tile" }] : []),
          getTile: () => ({ hasData: () => !!texture, texture, fadeOpacity: 1 }),
        },
      },
      getLayer: () => ({ paint: { get: () => opacity } }),
    } as unknown as MapLibreMap["style"],
  });
  useMapAttributionStore.setState({ byLayer: {} });
  useLayerStore.getState().setActiveLayer("cycling");
  const view = render(
    <RasterBaseLayer
      sourceId="base"
      layerId="base-layer"
      tiles={["https://tiles.example/{z}/{x}/{y}"]}
      activeWhen="cycling"
      maxzoom={8}
      attributions={[{ sourceId: "base", name: "Actual raster" }]}
    />,
  );
  const flush = () =>
    act(() => {
      fake.emit("render");
      vi.advanceTimersByTime(250);
    });
  const html = () =>
    Object.values(useMapAttributionStore.getState().byLayer)
      .flat()
      .map((entry) => entry.fullHtml)
      .join(" ");
  try {
    flush();
    expect(html()).toBe("");
    texture = {};
    flush();
    expect(html()).toContain("Actual raster");
    fake.state.zoom = 12;
    fake.state.styleLoaded = false;
    flush();
    expect(html()).toContain("Actual raster");
    opacity = 0;
    flush();
    expect(html()).toBe("");
    opacity = 1;
    visible = false;
    flush();
    expect(html()).toBe("");
  } finally {
    view.unmount();
    vi.useRealTimers();
  }
});

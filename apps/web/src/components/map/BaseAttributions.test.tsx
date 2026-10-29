// @vitest-environment jsdom
import type { MapGeoJSONFeature, StyleSpecification } from "maplibre-gl";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useMapAttributionStore } from "@/integration-api/overlay/mapAttributionStore";
import { installedNativeBasemap } from "@/integration-api/overlay/nativeBasemap";
import { act, createFakeMap, type FakeMap, render } from "@/test";
import { BaseAttributions } from "./BaseAttributions";

let fake: FakeMap;
vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ mapRef: { current: fake.map }, mapReady: true }),
}));
const html = () =>
  Object.values(useMapAttributionStore.getState().byLayer)
    .flat()
    .map((e) => e.fullHtml)
    .join(" ");
const feature = {
  type: "Feature",
  properties: {},
  geometry: { type: "Point", coordinates: [0, 0] },
} as MapGeoJSONFeature;
function flush() {
  act(() => {
    fake.emit("render");
    vi.advanceTimersByTime(250);
    fake.emit("render");
    vi.advanceTimersByTime(2_000);
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  fake = createFakeMap();
  fake.map.addSource("native", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });
  fake.map.addLayer({ id: "land", type: "fill", source: "native", maxzoom: 20 });
  fake.map.addLayer({
    id: "label",
    type: "symbol",
    maxzoom: 20,
    source: "native",
    layout: { "text-field": "label" },
  });
  Object.defineProperty(fake.map, "style", {
    value: { getLayer: (id: string) => fake.map.getLayer(id) },
    configurable: true,
  });
  fake.map.triggerRepaint = vi.fn();
  installedNativeBasemap(fake.map).adopt({
    style: fake.map.getStyle() as StyleSpecification,
    offline: false,
    sourceContributors: { native: [{ sourceId: "osm", name: "native-data" }] },
    styleContributors: [{ sourceId: "design", name: "native-design" }],
  });
  useMapAttributionStore.setState({ byLayer: {} });
});
afterEach(() => vi.useRealTimers());
it("credits installed native suppliers without feature queries or a repaint loop", () => {
  const query = vi.spyOn(fake.map, "queryRenderedFeatures");
  fake.setRenderedFeatures("label", [feature]);
  render(<BaseAttributions />);
  flush();
  expect(html()).toContain("native-data");
  expect(html()).toContain("native-design");
  expect(query).not.toHaveBeenCalled();
  expect(fake.map.triggerRepaint).not.toHaveBeenCalled();
});
it("keeps installed credits for hidden, empty and out-of-zoom native content", () => {
  fake.setRenderedFeatures("label", [feature]);
  render(<BaseAttributions />);
  flush();
  expect(html()).toContain("native-data");
  fake.map.setLayoutProperty("label", "visibility", "none");
  flush();
  expect(html()).toContain("native-data");
  fake.map.setLayoutProperty("label", "visibility", "visible");
  fake.state.zoom = 30;
  fake.setRenderedFeatures("label", []);
  flush();
  expect(html()).toContain("native-data");
});

it("publishes installation changes immediately and clears only its own owner on unmount", () => {
  useMapAttributionStore
    .getState()
    .setLayer("overlay", [
      { fullHtml: "overlay supplier", visibleHtml: "overlay supplier", logos: [] },
    ]);
  const view = render(<BaseAttributions />);
  expect(html()).toContain("native-data");
  fake.state.sources.set("native", { type: "geojson" });
  act(() =>
    installedNativeBasemap(fake.map).adopt({
      style: fake.map.getStyle() as StyleSpecification,
      offline: false,
      sourceContributors: { native: [{ sourceId: "new", name: "new-data" }] },
      styleContributors: [{ sourceId: "design", name: "new-design" }],
    }),
  );
  expect(html()).toContain("new-data");
  expect(html()).not.toContain("native-data");
  view.unmount();
  expect(html()).toBe("overlay supplier");
});
it("withdraws removed source/layer generations on style events without querying geometry", () => {
  render(<BaseAttributions />);
  flush();
  expect(html()).toContain("native-data");
  act(() => {
    fake.state.sources.delete("native");
    fake.emit("styledata");
  });
  expect(html()).toBe("");
});

it("preserves installed source and design receipts during a pending failed style change", () => {
  const controller = installedNativeBasemap(fake.map);
  fake.map.setStyle = () => fake.map;
  render(<BaseAttributions />);
  act(() => {
    controller.install(
      {
        style: {
          version: 8,
          sources: {},
          layers: [],
          metadata: { "openmapx:native-basemap-generation": 2 },
        } as StyleSpecification,
        offline: true,
        sourceContributors: { native: [{ sourceId: "pending", name: "pending-data" }] },
        styleContributors: [{ sourceId: "pending-design", name: "pending-design" }],
      },
      () => {},
    );
    fake.state.styleLoaded = false;
    fake.emit("styledata");
    fake.emit("style.load");
  });
  expect(html()).toContain("native-data");
  expect(html()).toContain("native-design");
  expect(html()).not.toContain("pending");
});

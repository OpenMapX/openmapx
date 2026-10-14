// @vitest-environment jsdom
import type { MapGeoJSONFeature, Map as MapLibreMap, StyleSpecification } from "maplibre-gl";
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
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  fake = createFakeMap();
  fake.map.addSource("native", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });
  fake.map.addLayer({ id: "land", type: "fill", source: "native" });
  fake.map.addLayer({
    id: "label",
    type: "symbol",
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
it("credits rendered native labels independently of a selected satellite base", () => {
  fake.setRenderedFeatures("label", [feature]);
  render(<BaseAttributions />);
  flush();
  expect(html()).toContain("native-data");
  expect(html()).toContain("native-design");
});
it("withdraws hidden, empty and out-of-zoom native content", () => {
  fake.setRenderedFeatures("label", [feature]);
  render(<BaseAttributions />);
  flush();
  expect(html()).toContain("native-data");
  fake.map.setLayoutProperty("label", "visibility", "none");
  flush();
  expect(html()).toBe("");
  fake.map.setLayoutProperty("label", "visibility", "visible");
  fake.setRenderedFeatures("label", []);
  flush();
  expect(html()).toBe("");
});

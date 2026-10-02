import { createPlace, useDataSourceStore, useParkingStore, usePlaceStore } from "@openmapx/core";
import { act, render } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { createFakeMap } from "@/test";
import { MapClickHandler } from "../MapClickHandler";
import { DataSourceLayer } from "./DataSourceLayer";

const fake = createFakeMap({ styleLoaded: true });
const mapRef = { current: fake.map };
const t = (key: string) => key;
let resolveToken = (_token: unknown) => "English";
let reads = 0;
const results = [
  {
    id: "one",
    name: "One",
    source: "sample",
    summary: { $t: "summary" },
    get coordinates() {
      reads++;
      return [8, 50];
    },
  },
];
const sources = {
  sources: [
    {
      id: "sample",
      minZoom: 5,
      placeCategory: "Sample",
      placeCategoryRaw: "sample",
      filters: [],
      markerStyle: { type: "circle", defaultColor: "red", variantColors: {}, inactiveOpacity: 0.5 },
    },
  ],
};
let context: { geojson: GeoJSON.FeatureCollection } | undefined;
const registry = { get: () => undefined };
vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ mapRef, mapReady: true, styleVersion: 0 }),
}));
vi.mock("next-intl", () => ({ useTranslations: () => t }));
vi.mock("@/components/panels/place/useDataSourceI18nResolver", () => ({
  useDataSourceI18nResolver: () => resolveToken,
}));
vi.mock("@/hooks/usePinMarker", () => ({ usePinMarker: vi.fn() }));
vi.mock("@/integration-api/overlay/useMapAttributions", () => ({ useMapAttributions: vi.fn() }));
vi.mock("@openmapx/integration-framework/react", () => ({
  useIntegrationRegistry: () => registry,
}));
vi.mock("@openmapx/core", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useDataSources: () => ({ data: sources }),
  useDataSourceSearch: () => ({ data: results, attributions: [], isFetching: false }),
  useDataSourceMapContext: () => ({ data: context }),
}));

it.each([true, false])(
  "suppresses delegated selections around picker capture (picker first: %s)",
  (pickerFirst) => {
    useDataSourceStore.setState({
      activeSource: "sample",
      filters: {},
      viewportZoom: 12,
      selectedItem: null,
    });
    const selected = createPlace({
      primaryScheme: "osm",
      ids: { osm: "node/1" },
      name: "Current",
      address: "",
      coordinates: [8, 50],
    });
    usePlaceStore.getState().setSelectedPlace(selected);
    const view = render(
      <>
        <DataSourceLayer />
        <MapClickHandler />
      </>,
    );
    const delegated = fake.state.listenerCalls.findLast(
      (call) =>
        call.method === "on" && call.event === "click" && call.layerId?.endsWith("-markers"),
    )?.handler;
    const picker = fake.state.listenerCalls.findLast(
      (call) => call.method === "on" && call.event === "click" && !call.layerId,
    )?.handler;
    expect(delegated).toBeDefined();
    expect(picker).toBeDefined();
    fake.state.renderedFeatures.set("ds-sample-markers", [
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [8, 50] },
        properties: { id: "one", name: "One" },
      } as never,
    ]);
    useParkingStore.getState().setPicking(true);
    const originalEvent = new MouseEvent("click");
    const event = () => ({ originalEvent, point: { x: 1, y: 2 }, lngLat: { lng: 8, lat: 50 } });
    act(() => {
      if (pickerFirst) {
        picker?.(event());
        delegated?.(event());
      } else {
        delegated?.(event());
        picker?.(event());
      }
    });
    expect(useParkingStore.getState().pickedCoords).toEqual([8, 50]);
    expect(useDataSourceStore.getState().selectedItem).toBeNull();
    expect(usePlaceStore.getState().selectedPlace).toBe(selected);
    act(() => delegated?.({ ...event(), originalEvent: new MouseEvent("click") }));
    expect(useDataSourceStore.getState().selectedItem).toEqual({
      sourceId: "sample",
      itemId: "one",
    });
    view.unmount();
    fake.state.renderedFeatures.clear();
    useParkingStore.getState().reset();
  },
);
it("does not rebuild or upload unchanged data-source results on style notifications", () => {
  useDataSourceStore.setState({ activeSource: "sample", filters: {}, viewportZoom: 12 });
  const view = render(<DataSourceLayer />);
  const uploads = fake.state.counts.setData.get("ds-sample") ?? 0;
  reads = 0;
  act(() => {
    for (let i = 0; i < 100; i++) fake.emit("styledata");
  });
  expect(fake.state.counts.setData.get("ds-sample") ?? 0).toBe(uploads);
  expect(reads).toBe(0);
  act(() => {
    fake.map.setStyle({} as never);
  });
  expect(
    (fake.state.sources.get("ds-sample")?.data as GeoJSON.FeatureCollection).features[0].properties
      ?.name,
  ).toBe("One");
  view.unmount();
});

it("refreshes locale and context data, clears context, and handles zoom and source changes", () => {
  fake.state.zoom = 12;
  useDataSourceStore.setState({ activeSource: "sample", filters: {}, viewportZoom: 12 });
  context = {
    geojson: {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { contextId: "zone" },
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [8, 50],
                [9, 50],
                [9, 51],
                [8, 50],
              ],
            ],
          },
        },
      ],
    },
  };
  const view = render(<DataSourceLayer />);
  expect(fake.state.sources.get("ds-sample-map-context")?.data).toBe(context.geojson);
  resolveToken = () => "Deutsch";
  view.rerender(<DataSourceLayer />);
  const markers = fake.state.sources.get("ds-sample")?.data as GeoJSON.FeatureCollection;
  expect(markers.features[0].properties?.summary).toBe("Deutsch");
  context = { geojson: { ...context.geojson, features: [] } };
  view.rerender(<DataSourceLayer />);
  expect(fake.state.sources.has("ds-sample-map-context")).toBe(false);
  act(() => {
    useDataSourceStore.setState({ viewportZoom: 1 });
  });
  expect(fake.state.sources.has("ds-sample")).toBe(false);
  act(() => {
    useDataSourceStore.setState({ viewportZoom: 12 });
  });
  expect(fake.state.sources.has("ds-sample")).toBe(true);
  act(() => {
    useDataSourceStore.setState({ activeSource: null });
  });
  expect(fake.state.sources.has("ds-sample")).toBe(false);
  view.unmount();
  context = undefined;
});

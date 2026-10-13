import { createPlace, useDataSourceStore, useParkingStore, usePlaceStore } from "@openmapx/core";
import { act, render, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useMapAttributionStore } from "@/integration-api/overlay/mapAttributionStore";
import { createFakeMap } from "@/test";
import { MapClickHandler } from "../MapClickHandler";
import { DataSourceLayer } from "./DataSourceLayer";

const fake = createFakeMap({ styleLoaded: true });
const mapRef = { current: fake.map };
const t = (key: string) => key;
let resolveToken = (_token: unknown) => "English";
let reads = 0;
const logoLoad = vi.fn();
vi.mock("@/lib/dataSourceBrandMarker", () => ({
  dataSourceBrandImageId: (url: string) => `ds-brand-${encodeURIComponent(url)}`,
  loadDataSourceBrandMarker: (...args: unknown[]) => logoLoad(...args),
}));
const results = [
  {
    id: "one",
    name: "One",
    source: "sample",
    summary: { $t: "summary" },
    branding: undefined as { logoUrl: string } | undefined,
    availability: undefined as { available: number; total: number } | undefined,
    contributors: undefined as
      | { sourceId: string; name: string; attributionText?: string }[]
      | undefined,
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
let searchIsFetching = false;
vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ mapRef, mapReady: true, styleVersion: 0 }),
}));
vi.mock("next-intl", () => ({ useTranslations: () => t }));
vi.mock("@/components/panels/place/useDataSourceI18nResolver", () => ({
  useDataSourceI18nResolver: () => resolveToken,
}));
vi.mock("@/hooks/usePinMarker", () => ({ usePinMarker: vi.fn() }));
vi.mock("@openmapx/integration-framework/react", () => ({
  useIntegrationRegistry: () => registry,
}));
vi.mock("@openmapx/core", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useDataSources: () => ({ data: sources }),
  useDataSourceSearch: () => ({ data: results, attributions: [], isFetching: searchIsFetching }),
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
  expect(fake.state.sources.get("ds-sample-map-context")?.data).toMatchObject(context.geojson);
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

it("adds a supplied logo pin while retaining live availability styling and fallback", async () => {
  results[0].branding = { logoUrl: "https://provider.example/logo.png" };
  results[0].availability = { available: 0, total: 4 };
  logoLoad.mockImplementation(async (...args: unknown[]) => {
    const [map, url, isCurrent] = args as [import("maplibre-gl").Map, string, () => boolean];
    if (isCurrent()) map.addImage(`ds-brand-${encodeURIComponent(url)}`, {} as never);
    return isCurrent();
  });
  useDataSourceStore.setState({ activeSource: "sample", filters: {}, viewportZoom: 12 });
  const view = render(<DataSourceLayer />);
  await waitFor(() => expect(fake.map.getLayer("ds-sample-brand-logos")).toBeDefined());
  expect(logoLoad).toHaveBeenCalledWith(
    fake.map,
    results[0].branding.logoUrl,
    expect.any(Function),
  );
  const data = fake.state.sources.get("ds-sample")?.data as GeoJSON.FeatureCollection;
  expect(data.features[0].properties?.brandImageId).toBe(
    "ds-brand-https%3A%2F%2Fprovider.example%2Flogo.png",
  );
  expect(fake.map.getLayer("ds-sample-markers")?.type).toBe("circle");
  expect(fake.map.getLayer("ds-sample-brand-halos")?.type).toBe("circle");
  expect(data.features[0].properties?.availState).toBe("busy");
  expect(fake.map.getPaintProperty("ds-sample-brand-halos", "circle-color")).toEqual([
    "match",
    ["get", "availState"],
    "available",
    "#2E7D32",
    "busy",
    "#F9A825",
    ["literal", "red"],
  ]);
  view.unmount();
  results[0].branding = undefined;
  results[0].availability = undefined;
});

it("ignores late logos after source changes and reloads logos after style replacement", async () => {
  results[0].branding = { logoUrl: "https://provider.example/race.png" };
  const pending: { current: () => boolean; resolve: (loaded: boolean) => void }[] = [];
  logoLoad.mockImplementation(
    (...args: unknown[]) =>
      new Promise<boolean>((resolve) =>
        pending.push({ current: args[2] as () => boolean, resolve }),
      ),
  );
  useDataSourceStore.setState({ activeSource: "sample", filters: {}, viewportZoom: 12 });
  const view = render(<DataSourceLayer />);
  expect(pending).toHaveLength(1);
  fake.state.styleLoaded = false;
  // Tile loading does not invalidate the still-current stylesheet/source.
  expect(pending[0].current()).toBe(true);
  fake.state.styleLoaded = true;
  act(() => fake.map.setStyle({} as never));
  expect(pending).toHaveLength(2);
  expect(pending[0].current()).toBe(false);
  expect(pending[1].current()).toBe(true);
  await act(async () => pending[0].resolve(false));
  act(() => useDataSourceStore.setState({ activeSource: null }));
  expect(pending[1].current()).toBe(false);
  await act(async () => pending[1].resolve(false));
  expect(fake.map.getSource("ds-sample")).toBeUndefined();
  expect(fake.map.getLayer("ds-sample-brand-logos")).toBeUndefined();
  view.unmount();
  results[0].branding = undefined;
  results[0].availability = undefined;
});

it("keeps generic pins after a logo failure without retrying each style notification", async () => {
  results[0].branding = { logoUrl: "https://provider.example/missing.png" };
  logoLoad.mockReset().mockResolvedValue(false);
  useDataSourceStore.setState({ activeSource: "sample", filters: {}, viewportZoom: 12 });
  const view = render(<DataSourceLayer />);
  await act(async () => {});
  act(() => {
    for (let i = 0; i < 20; i++) fake.emit("styledata");
  });
  expect(logoLoad).toHaveBeenCalledTimes(1);
  const data = fake.state.sources.get("ds-sample")?.data as GeoJSON.FeatureCollection;
  expect(data.features[0].properties?.brandImageId).toBeUndefined();
  expect(fake.map.getLayer("ds-sample-markers")).toBeDefined();
  view.unmount();
  results[0].branding = undefined;
  results[0].availability = undefined;
});

it("selects a branded result once when overlapping layers receive the same click", () => {
  useDataSourceStore.setState({ activeSource: "sample", filters: {}, viewportZoom: 12 });
  const select = vi.spyOn(useDataSourceStore.getState(), "selectItem");
  const view = render(<DataSourceLayer />);
  fake.state.renderedFeatures.set("ds-sample-markers", [
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [8, 50] },
      properties: { id: "one", name: "One" },
    } as never,
  ]);
  const originalEvent = new MouseEvent("click");
  const handlers = ["ds-sample-markers", "ds-sample-brand-halos", "ds-sample-brand-logos"].map(
    (layerId) =>
      fake.state.listenerCalls.findLast(
        (call) => call.method === "on" && call.event === "click" && call.layerId === layerId,
      )?.handler,
  );
  act(() => {
    for (const handler of handlers)
      handler?.({ originalEvent, point: { x: 1, y: 2 }, lngLat: { lng: 8, lat: 50 } });
  });
  expect(select).toHaveBeenCalledTimes(1);
  view.unmount();
  select.mockRestore();
  fake.state.renderedFeatures.clear();
});

it("credits only rendered markers and context polygons and retains captured visible credits during refresh", () => {
  vi.useFakeTimers();
  fake.state.zoom = 12;
  useMapAttributionStore.setState({ byLayer: {} });
  useDataSourceStore.setState({ activeSource: "sample", filters: {}, viewportZoom: 12 });
  const receipt = { sourceId: "record-a", name: "Record A", attributionText: "Original notice" };
  results[0].contributors = [receipt];
  results.push({
    ...results[0],
    id: "two",
    name: "Two",
    contributors: [{ sourceId: "record-b", name: "Record B" }],
  });
  context = {
    geojson: {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
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
          properties: {
            _mapAttributions: JSON.stringify([{ sourceId: "context", name: "Context only" }]),
          },
        },
      ],
    },
  };
  const view = render(<DataSourceLayer />);
  const uploaded = fake.state.sources.get("ds-sample")?.data as GeoJSON.FeatureCollection;
  const uploadedContext = fake.state.sources.get("ds-sample-map-context")
    ?.data as GeoJSON.FeatureCollection;
  fake.setRenderedFeatures("ds-sample-markers", uploaded.features as never);
  fake.setRenderedFeatures("ds-sample-map-context-fill", uploadedContext.features as never);
  const flush = () =>
    act(() => {
      fake.emit("render");
      vi.advanceTimersByTime(250);
    });
  const html = () => Object.values(useMapAttributionStore.getState().byLayer).flat().join(" ");
  flush();
  expect(html()).toContain("Original notice");
  expect(html()).toContain("Record B");
  expect(html()).toContain("Context only");
  fake.setRenderedFeatures("ds-sample-markers", uploaded.features.slice(0, 1) as never);
  act(() => fake.emit("move"));
  flush();
  expect(html()).not.toContain("Record B");
  searchIsFetching = true;
  receipt.attributionText = "Mutated later metadata";
  view.rerender(<DataSourceLayer />);
  flush();
  expect(html()).toContain("Original notice");
  expect(html()).not.toContain("Mutated later metadata");
  fake.setRenderedFeatures("ds-sample-markers", []);
  fake.setRenderedFeatures("ds-sample-map-context-fill", []);
  act(() => fake.emit("move"));
  flush();
  expect(html()).toBe("");
  view.unmount();
  context = undefined;
  results.pop();
  results[0].contributors = undefined;
  searchIsFetching = false;
  vi.useRealTimers();
});

it("serializes independent label, paint and logo channels with authoritative empty fields", async () => {
  const { buildGeoJson } = await import("./DataSourceLayer");
  const credit = (sourceId: string) => [{ sourceId, name: sourceId }];
  const place = {
    id: "channels",
    name: "Name",
    source: "feed",
    variant: "named",
    status: "non-operational",
    summary: { $t: "summary" },
    coordinates: [8, 50] as [number, number],
    branding: { logoUrl: "https://provider.example/channel.png" },
    availability: { available: 0, total: 4 },
    contributors: credit("hidden"),
    fieldContributors: {
      coordinates: credit("coords"),
      name: credit("name"),
      summary: credit("summary"),
      variant: credit("unused-variant"),
      status: credit("status"),
      "availability.total": credit("availability"),
      "availability.available": [],
      "branding.logoUrl": credit("actual-file"),
      "branding.name": credit("unused-brand-name"),
    },
  };
  const f = buildGeoJson([place], () => "Summary", "icon", {
    ...sources.sources[0].markerStyle,
    type: "icon",
    iconPath: "",
  }).features[0];
  const ids = (key: string) =>
    JSON.parse(f.properties[key as keyof typeof f.properties] as string).map(
      (receipt: { sourceId: string }) => receipt.sourceId,
    );
  expect(ids("_mapMarkerAttributions")).toEqual(["coords"]);
  expect(ids("_mapHaloAttributions")).toEqual(["coords", "availability", "status"]);
  expect(ids("_mapLabelAttributions")).toEqual(["coords", "name"]);
  expect(ids("_mapSummaryLabelAttributions")).toEqual(["coords", "name", "summary"]);
  expect(ids("_mapLogoSelectionAttributions")).toEqual(["coords", "actual-file", "status"]);
  expect(ids("_mapLogoFileAttributions")).toEqual(["actual-file"]);
});

it("adds captured file receipts only after the actual logo image loads and only to its rendered logo channel", async () => {
  vi.useFakeTimers();
  fake.state.zoom = 12;
  useMapAttributionStore.setState({ byLayer: {} });
  const old = results[0];
  const file = {
    sourceId: "file",
    name: "Original logo file",
    attributionText: "Required logo notice",
  };
  const row = {
    id: "loaded-logo",
    name: "Station",
    source: "feed",
    variant: "",
    coordinates: [8, 50],
    branding: { name: "Hidden catalog brand", logoUrl: "https://provider.example/receipt.png" },
    contributors: [{ sourceId: "all", name: "Blended hidden" }],
    fieldContributors: {
      coordinates: [{ sourceId: "feed", name: "Feed geometry" }],
      name: [{ sourceId: "name", name: "Hidden name" }],
      "branding.name": [{ sourceId: "nsi", name: "Hidden NSI brand" }],
      "branding.logoUrl": [file],
    },
  };
  results[0] = row as unknown as typeof old;
  const pending = Promise.withResolvers<boolean>();
  logoLoad.mockImplementation((...args: unknown[]) => {
    const [map, url, isCurrent] = args as [import("maplibre-gl").Map, string, () => boolean];
    return pending.promise.then((loaded) => {
      if (loaded && isCurrent()) map.addImage(`ds-brand-${encodeURIComponent(url)}`, {} as never);
      return loaded && isCurrent();
    });
  });
  useDataSourceStore.setState({ activeSource: "sample", filters: {}, viewportZoom: 12 });
  const view = render(<DataSourceLayer />);
  const flush = () =>
    act(() => {
      fake.emit("render");
      vi.advanceTimersByTime(250);
    });
  const html = () => Object.values(useMapAttributionStore.getState().byLayer).flat().join(" ");
  try {
    let data = fake.state.sources.get("ds-sample")?.data as GeoJSON.FeatureCollection;
    fake.setRenderedFeatures("ds-sample-markers", data.features as never);
    fake.setRenderedFeatures(
      "ds-sample-brand-logos",
      data.features.map((feature) => ({
        ...feature,
        layer: {
          id: "ds-sample-brand-logos",
          type: "symbol",
          layout: { "icon-image": feature.properties?.brandImageId ?? "" },
          paint: { "icon-opacity": 1 },
        },
      })) as never,
    );
    flush();
    expect(html()).toContain("Feed geometry");
    expect(html()).not.toContain("Required logo notice");
    file.name = "Metadata mutated while pending";
    await act(async () => {
      pending.resolve(true);
      await pending.promise;
    });
    data = fake.state.sources.get("ds-sample")?.data as GeoJSON.FeatureCollection;
    fake.setRenderedFeatures(
      "ds-sample-brand-logos",
      data.features.map((feature) => ({
        ...feature,
        layer: {
          id: "ds-sample-brand-logos",
          type: "symbol",
          layout: { "icon-image": feature.properties?.brandImageId ?? "" },
          paint: { "icon-opacity": 1 },
        },
      })) as never,
    );
    flush();
    expect(html()).toContain("Required logo notice");
    expect(
      JSON.parse(data.features[0].properties?._mapBrandAttributions ?? "[]").find(
        (receipt: { sourceId: string }) => receipt.sourceId === "file",
      ).name,
    ).toBe("Original logo file");
    expect(html()).not.toContain("Metadata mutated");
    expect(html()).not.toContain("Hidden NSI");
    expect(html()).not.toContain("Hidden name");
    fake.setRenderedFeatures("ds-sample-brand-logos", []);
    fake.setRenderedFeatures("ds-sample-brand-halos", data.features as never);
    flush();
    expect(html()).not.toContain("Required logo notice");
    expect(html()).toContain("Feed geometry");
  } finally {
    view.unmount();
    results[0] = old;
    logoLoad.mockReset();
    fake.setRenderedFeatures("ds-sample-markers", []);
    fake.setRenderedFeatures("ds-sample-brand-logos", []);
    fake.setRenderedFeatures("ds-sample-brand-halos", []);
    vi.useRealTimers();
  }
});

it("credits the actual name label and adds summary ownership only after its zoom branch paints", () => {
  vi.useFakeTimers();
  fake.state.zoom = 12;
  useMapAttributionStore.setState({ byLayer: {} });
  const old = results[0];
  const style = sources.sources[0].markerStyle;
  const oldType = style.type;
  Object.assign(style, { type: "icon", iconPath: "" });
  fake.map.addImage("ds-marker-sample", {} as never);
  results[0] = {
    id: "label-channels",
    name: "Name",
    source: "feed",
    variant: "",
    coordinates: [8, 50],
    summary: { $t: "summary" },
    contributors: [{ sourceId: "all", name: "Hidden blended" }],
    fieldContributors: {
      coordinates: [{ sourceId: "coords", name: "Coordinates" }],
      name: [{ sourceId: "name", name: "Painted name" }],
      summary: [{ sourceId: "summary", name: "High zoom summary" }],
    },
  } as unknown as typeof old;
  useDataSourceStore.setState({ activeSource: "sample", filters: {}, viewportZoom: 12 });
  const view = render(<DataSourceLayer />);
  try {
    const data = fake.state.sources.get("ds-sample")?.data as GeoJSON.FeatureCollection;
    const setLabel = (text: string) =>
      fake.setRenderedFeatures(
        "ds-sample-labels",
        data.features.map((feature) => ({
          ...feature,
          layer: {
            id: "ds-sample-labels",
            type: "symbol",
            layout: { "text-field": text },
            paint: { "text-opacity": 1 },
          },
        })) as never,
      );
    const flush = () =>
      act(() => {
        fake.emit("render");
        vi.advanceTimersByTime(250);
      });
    const html = () => Object.values(useMapAttributionStore.getState().byLayer).flat().join(" ");
    setLabel("Name");
    flush();
    expect(html()).toContain("Painted name");
    expect(html()).not.toContain("High zoom summary");
    expect(html()).not.toContain("Hidden blended");
    fake.state.zoom = 13;
    setLabel("Name\nEnglish");
    flush();
    expect(html()).toContain("High zoom summary");
    fake.state.zoom = 12;
    setLabel("Name");
    flush();
    expect(html()).not.toContain("High zoom summary");
  } finally {
    view.unmount();
    results[0] = old;
    style.type = oldType;
    fake.setRenderedFeatures("ds-sample-labels", []);
    vi.useRealTimers();
  }
});

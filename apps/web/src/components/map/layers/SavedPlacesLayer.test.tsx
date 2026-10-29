import {
  PANEL,
  type SavedPlace,
  useMapClickStore,
  useParkingStore,
  usePlaceStore,
  useSavedPlacesStore,
  useSidebarStore,
} from "@openmapx/core";
import { act, render } from "@testing-library/react";
import type { MapGeoJSONFeature } from "maplibre-gl";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { INTERACTIVE_LAYER_IDS } from "@/integration-api/map/interactiveLayers";
import { useMapAttributionStore } from "@/integration-api/overlay/mapAttributionStore";
import { createFakeMap } from "@/test";
import { MapClickHandler } from "../MapClickHandler";
import { findStylePoiAtPoint } from "../mapStylePoiTarget";
import { loadListMarkerImage, SavedPlacesLayer } from "./SavedPlacesLayer";

const { pin } = vi.hoisted(() => ({
  pin: vi.fn(),
}));
vi.mock("@/hooks/usePinMarker", () => ({ usePinMarker: pin }));
const flyTo = vi.fn();
const fields = {
  name: [{ sourceId: "name", name: "Hidden name receipt" }],
  lat: [{ sourceId: "coordinate", name: "Acquired coordinate receipt" }],
  lng: [],
};
const originalPlaces: SavedPlace[] = [
  {
    id: "saved",
    listId: "list",
    name: "Saved point",
    address: null,
    lat: 50,
    lng: 8,
    placeId: null,
    note: null,
    sortOrder: 0,
    createdAt: "2026-10-15T00:00:00Z",
    fieldContributors: fields,
  },
];
let places: SavedPlace[] = originalPlaces;
let listIcon: string | null = "heart";
let fake = createFakeMap({ zoom: 16 });
const mapRef = { current: fake.map };
vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ mapRef, mapReady: true, styleVersion: 0, flyTo }),
}));
vi.mock("@openmapx/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openmapx/core")>()),
  useSavedListPlaces: () => ({ data: places }),
  useSavedLists: () => ({ data: [{ id: "list", icon: listIcon }] }),
}));
beforeEach(() => {
  listIcon = "heart";
  places = originalPlaces;
  useSavedPlacesStore.getState().selectList("list");
  useSidebarStore.setState({ activeSidebarId: PANEL.SAVED, activeDetailId: null });
  usePlaceStore.getState().setSelectedPlace(null);
  useParkingStore.getState().reset();
  useMapClickStore.getState().setClickedLngLat(null);
  pin.mockClear();
  flyTo.mockClear();
  fake = createFakeMap({ zoom: 16 });
  mapRef.current = fake.map;
  fake.state.images.add("saved-list-marker-heart");
  useMapAttributionStore.setState({ byLayer: {} });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it("credits only painted saved coordinates and releases ownership on unmount", () => {
  vi.useFakeTimers();
  useMapAttributionStore.setState({ byLayer: {} });
  const view = render(<SavedPlacesLayer />);
  const data = fake.state.sources.get("saved-places-source")?.data as GeoJSON.FeatureCollection;
  expect(JSON.parse(data.features[0].properties?._mapAttributions)).toEqual(fields.lat);
  const html = () =>
    Object.values(useMapAttributionStore.getState().byLayer)
      .flat()
      .map((entry) => entry.fullHtml)
      .join(" ");
  expect(html()).toBe("");
  fake.setRenderedFeatures("saved-places-layer", renderedFeatures(data, "saved-places-layer"));
  act(() => {
    fake.emit("render");
    vi.advanceTimersByTime(250);
  });
  expect(html()).toContain("Acquired coordinate receipt");
  expect(html()).not.toContain("Hidden name receipt");
  fake.setRenderedFeatures("saved-places-layer", []);
  act(() => {
    fake.emit("render");
    vi.advanceTimersByTime(250);
  });
  expect(html()).toBe("");
  view.unmount();
  expect(fake.state.sources.has("saved-places-source")).toBe(false);
  expect(html()).toBe("");
});

it.each([
  { label: "absent", capture: undefined },
  { label: "empty", capture: { lat: [], lng: [] } },
  { label: "invalid", capture: { lat: "invalid" } },
])(
  "renders receipt-free saved markers without attribution queries for $label captures",
  ({ capture }) => {
    vi.useFakeTimers();
    places = Array.from({ length: 10_000 }, (_, i) => ({
      ...originalPlaces[0],
      id: `saved-${i}`,
      fieldContributors: capture as SavedPlace["fieldContributors"],
    }));
    const query = vi.spyOn(fake.map, "queryRenderedFeatures");
    const view = render(<SavedPlacesLayer />);
    const data = fake.state.sources.get("saved-places-source")?.data as GeoJSON.FeatureCollection;
    expect(data.features).toHaveLength(10_000);
    act(() => {
      fake.emit("render");
      vi.advanceTimersByTime(250);
    });
    expect(query).not.toHaveBeenCalled();
    expect(useMapAttributionStore.getState().byLayer).toEqual({});
    view.unmount();
  },
);

it("enables and releases exact coordinate-credit tracking as saved captures change", () => {
  vi.useFakeTimers();
  places = [{ ...originalPlaces[0], fieldContributors: {} }];
  const query = vi.spyOn(fake.map, "queryRenderedFeatures");
  const view = render(<SavedPlacesLayer />);
  act(() => {
    fake.emit("render");
    vi.advanceTimersByTime(250);
  });
  expect(query).not.toHaveBeenCalled();
  places = originalPlaces;
  view.rerender(<SavedPlacesLayer />);
  const data = fake.state.sources.get("saved-places-source")?.data as GeoJSON.FeatureCollection;
  fake.setRenderedFeatures("saved-places-layer", renderedFeatures(data, "saved-places-layer"));
  act(() => {
    fake.emit("render");
    vi.advanceTimersByTime(250);
  });
  expect(
    Object.values(useMapAttributionStore.getState().byLayer)
      .flat()
      .map((e) => e.fullHtml)
      .join(" "),
  ).toContain("Acquired coordinate receipt");
  places = [{ ...originalPlaces[0], fieldContributors: { lat: [], lng: [] } }];
  view.rerender(<SavedPlacesLayer />);
  query.mockClear();
  act(() => {
    fake.emit("render");
    vi.advanceTimersByTime(250);
  });
  expect(query).not.toHaveBeenCalled();
  expect(useMapAttributionStore.getState().byLayer).toEqual({});
  expect(fake.state.sources.has("saved-places-source")).toBe(true);
  view.unmount();
});

function renderedFeatures(data: GeoJSON.FeatureCollection, layerId: string) {
  return data.features.map((feature) => ({
    ...feature,
    layer: {
      id: layerId,
      type: "symbol",
      layout:
        layerId === "saved-places-labels"
          ? { "text-field": feature.properties?.name }
          : { "icon-image": feature.properties?.imageId },
    },
  })) as MapGeoJSONFeature[];
}

function paintMarker() {
  const data = fake.state.sources.get("saved-places-source")?.data as GeoJSON.FeatureCollection;
  fake.setRenderedFeatures("saved-places-layer", renderedFeatures(data, "saved-places-layer"));
  return data;
}

it("opens the saved place from a marker and filters its selected symbol", () => {
  render(<SavedPlacesLayer />);
  paintMarker();
  act(() =>
    fake.emit("click", { point: { x: 20, y: 20 }, originalEvent: new MouseEvent("click") }),
  );
  expect(usePlaceStore.getState().selectedPlace).toMatchObject({
    name: "Saved point",
    coordinates: [8, 50],
    ids: { saved: "saved" },
  });
  expect(useSidebarStore.getState().activeSidebarId).toBe(PANEL.SAVED);
  expect(useSidebarStore.getState().activeDetailId).toBe(PANEL.PLACE_CARD);
  expect(flyTo).toHaveBeenCalledWith([8, 50], 15);
  expect(fake.state.filters.get("saved-places-layer")).toEqual(["!=", ["get", "id"], "saved"]);
});

it("offers the shared accessible hover pin and pointer cursor", () => {
  const view = render(<SavedPlacesLayer />);
  paintMarker();
  act(() =>
    fake.emit("mousemove", { point: { x: 20, y: 20 }, originalEvent: new MouseEvent("mousemove") }),
  );
  expect(fake.map.getCanvasContainer().style.cursor).toBe("pointer");
  const args = pin.mock.calls.at(-1);
  expect(args?.[0]).toEqual([8, 50]);
  expect(args?.[1]).toBe("Saved point");
  const activate = args?.[4];
  if (typeof activate !== "function") throw new Error("Missing hover activation");
  act(() => activate());
  expect(usePlaceStore.getState().selectedPlace?.ids.saved).toBe("saved");
  view.unmount();
  expect(fake.map.getCanvasContainer().style.cursor).toBe("");
});

it("registers both hit layers against background clicks and respects owned tool clicks", async () => {
  const { INTERACTIVE_LAYER_IDS } = await import("@/integration-api/map/interactiveLayers");
  const view = render(<SavedPlacesLayer />);
  expect(INTERACTIVE_LAYER_IDS.has("saved-places-layer")).toBe(true);
  expect(INTERACTIVE_LAYER_IDS.has("saved-places-labels")).toBe(true);
  paintMarker();
  useParkingStore.getState().setPicking(true);
  act(() =>
    fake.emit("click", { point: { x: 20, y: 20 }, originalEvent: new MouseEvent("click") }),
  );
  expect(usePlaceStore.getState().selectedPlace).toBeNull();
  view.unmount();
  expect(INTERACTIVE_LAYER_IDS.has("saved-places-layer")).toBe(false);
  expect(INTERACTIVE_LAYER_IDS.has("saved-places-labels")).toBe(false);
});

it("credits saved names only through visible labels", () => {
  vi.useFakeTimers();
  places = [{ ...originalPlaces[0], fieldContributors: { name: fields.name } }];
  const view = render(<SavedPlacesLayer />);
  const data = paintMarker();
  const html = () =>
    Object.values(useMapAttributionStore.getState().byLayer)
      .flat()
      .map((e) => e.fullHtml)
      .join(" ");
  act(() => {
    fake.emit("render");
    vi.advanceTimersByTime(250);
  });
  expect(html()).toBe("");
  fake.setRenderedFeatures("saved-places-labels", renderedFeatures(data, "saved-places-labels"));
  act(() => {
    fake.emit("render");
    vi.advanceTimersByTime(250);
  });
  expect(html()).toContain("Hidden name receipt");
  view.unmount();
});

it("removes list markers and hover pins when the saved panel closes", () => {
  render(<SavedPlacesLayer />);
  paintMarker();
  act(() => fake.emit("mousemove", { point: { x: 20, y: 20 } }));
  act(() => useSidebarStore.getState().closeAll());
  expect(fake.state.sources.has("saved-places-source")).toBe(false);
  expect(pin.mock.calls.at(-1)?.[0]).toBeNull();
});

it("rebuilds the shared symbols and populated source after a style change", () => {
  const view = render(<SavedPlacesLayer />);
  act(() => fake.map.setStyle({ version: 8, sources: {}, layers: [] }));
  expect(fake.state.layers.get("saved-places-layer")?.type).toBe("symbol");
  const data = fake.state.sources.get("saved-places-source")?.data as GeoJSON.FeatureCollection;
  expect(data.features[0].properties?.imageId).toBe("saved-list-marker-heart");
  expect(fake.state.layout.get("saved-places-layer")?.["icon-allow-overlap"]).toBe(false);
  view.unmount();
});

it("rasterizes complete emoji over the shared marker before registering a retina sprite", () => {
  let image: HTMLImageElement | undefined;
  vi.stubGlobal(
    "Image",
    class {
      onload?: () => void;
      constructor() {
        image = this as unknown as HTMLImageElement;
      }
    },
  );
  const pixels = { width: 64, height: 64, data: new Uint8ClampedArray(64 * 64 * 4) };
  const context = { drawImage: vi.fn(), fillText: vi.fn(), getImageData: vi.fn(() => pixels) };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
  const addImage = vi.spyOn(fake.map, "addImage");
  loadListMarkerImage(fake.map, "emoji", "👩🏽‍🚀", () => true);
  image?.onload?.(new Event("load"));
  expect(context.drawImage).toHaveBeenCalledWith(image, 0, 0);
  expect(context.fillText).toHaveBeenCalledWith("👩🏽‍🚀", 32, 34, 40);
  expect(addImage).toHaveBeenCalledWith("emoji", pixels, { pixelRatio: 2 });
  vi.unstubAllGlobals();
});

it("ignores a sprite load that finishes after its list or style is replaced", () => {
  let image: HTMLImageElement | undefined;
  vi.stubGlobal(
    "Image",
    class {
      onload?: () => void;
      constructor() {
        image = this as unknown as HTMLImageElement;
      }
    },
  );
  loadListMarkerImage(fake.map, "stale", "star", () => false);
  image?.onload?.(new Event("load"));
  expect(fake.map.hasImage("stale")).toBe(false);
  vi.unstubAllGlobals();
});

it.each(["saved-places-layer", "saved-places-labels"])(
  "keeps %s clicks out of POI and background handlers",
  (layerId) => {
    render(
      <>
        <MapClickHandler />
        <SavedPlacesLayer />
      </>,
    );
    const data = fake.state.sources.get("saved-places-source")?.data as GeoJSON.FeatureCollection;
    fake.setRenderedFeatures(layerId, renderedFeatures(data, layerId));
    fake.state.layers.set("poi-label", { id: "poi-label", type: "symbol" });
    fake.setRenderedFeatures("poi-label", [
      { ...data.features[0], properties: { name: "Underlying POI" } },
    ] as unknown as MapGeoJSONFeature[]);
    expect(
      findStylePoiAtPoint(fake.map, [20, 20], ["poi-label"], INTERACTIVE_LAYER_IDS),
    ).toBeNull();
    act(() =>
      fake.emit("click", {
        point: { x: 20, y: 20 },
        lngLat: { lng: 8, lat: 50 },
        originalEvent: new MouseEvent("click"),
      }),
    );
    expect(usePlaceStore.getState().selectedPlace?.ids.saved).toBe("saved");
    expect(useMapClickStore.getState().clickedLngLat).toBeNull();
    expect(useSidebarStore.getState().activeDetailId).toBe(PANEL.PLACE_CARD);
  },
);

it.each(["osm:node/123", "invalid-place-id", null])(
  "preserves panel identity and field receipts for %s",
  (placeId) => {
    places = [{ ...originalPlaces[0], placeId }];
    render(<SavedPlacesLayer />);
    paintMarker();
    act(() =>
      fake.emit("click", { point: { x: 20, y: 20 }, originalEvent: new MouseEvent("click") }),
    );
    const selected = usePlaceStore.getState().selectedPlace;
    expect(selected?.id).toBe(placeId === "osm:node/123" ? placeId : "saved:saved");
    expect(selected?.fieldContributors?.name).toEqual(fields.name);
    expect(selected?.fieldContributors?.coordinates).toEqual(fields.lat);
    expect(fake.state.filters.get("saved-places-layer")).toEqual(["!=", ["get", "id"], "saved"]);
  },
);

it.each([
  ["Favorites", "heart"],
  ["Want to go", "flag"],
  ["Starred", "star"],
  ["custom symbol", "bookmark"],
  ["custom emoji", "🏕️"],
  ["default", null],
])("uses the opened list's %s icon for every map place", (_label, icon) => {
  listIcon = icon;
  render(<SavedPlacesLayer />);
  const data = fake.state.sources.get("saved-places-source")?.data as GeoJSON.FeatureCollection;
  expect(data.features[0].properties?.imageId).toBe(
    `saved-list-marker-${encodeURIComponent(icon ?? "bookmark")}`,
  );
});

import { categoryPlaceToPlace, useCategorySearchStore, usePlaceStore } from "@openmapx/core";
import { act, render } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { usePinMarker } from "@/hooks/usePinMarker";
import { createFakeMap } from "@/test";
import { CategoryResultMarkers } from "./CategoryResultMarkers";

const fake = createFakeMap({ styleLoaded: true });
const mapRef = { current: fake.map };
let reads = 0;
const result = {
  id: "one",
  name: "One",
  get coordinates() {
    reads++;
    return [8, 50];
  },
};
const reach = { filtered: [result], isTransitCategory: false };
let transitStops:
  | Array<{ id: string; name: string; lat: number; lng: number; modes: string[]; provider: string }>
  | undefined;
vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ mapRef, mapReady: true, styleVersion: 0, flyTo: vi.fn() }),
}));
vi.mock("@/lib/useExploreReachResults", () => ({ useExploreReachResults: () => reach }));
vi.mock("@/hooks/usePinMarker", () => ({ usePinMarker: vi.fn() }));
vi.mock("@openmapx/core", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useTransitStops: () => ({ data: transitStops }),
}));
it("reuses category data across style events and restores it after replacement", async () => {
  useCategorySearchStore.setState({ activeCategory: "restaurant" });
  const view = render(<CategoryResultMarkers />);
  reads = 0;
  await act(async () => {
    for (let i = 0; i < 100; i++) fake.emit("styledata");
  });
  expect(fake.state.counts.setData.get("category-results-source") ?? 0).toBe(0);
  expect(reads).toBe(0);
  act(() => {
    fake.map.setStyle({} as never);
  });
  const data = fake.state.sources.get("category-results-source")?.data as GeoJSON.FeatureCollection;
  expect(data.features[0].properties?.name).toBe("One");
  view.unmount();
});

it("keeps brand-enriched data on unrelated events and fences old image completions after a style replacement", async () => {
  const OriginalImage = globalThis.Image;
  const images: Array<{ onload: (() => void) | null }> = [];
  globalThis.Image = class {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    src = "";
    constructor() {
      images.push(this);
    }
  } as unknown as typeof Image;
  const oldResults = reach.filtered;
  try {
    fake.map.setStyle({} as never);
    fake.map.addImage("brand-marker-Q1", {} as never);
    reach.filtered = [
      {
        id: "brand",
        name: "Brand",
        coordinates: [8, 50],
        osmTags: { "brand:wikidata": "Q1" },
      } as typeof result,
    ];
    useCategorySearchStore.setState({ activeCategory: "restaurant" });
    const view = render(<CategoryResultMarkers />);
    await act(async () => {});
    const data = () =>
      fake.state.sources.get("category-results-source")?.data as GeoJSON.FeatureCollection;
    expect(data().features[0].properties?.imageId).toBe("brand-marker-Q1");
    const uploads = fake.state.counts.setData.get("category-results-source");
    await act(async () => {
      for (let i = 0; i < 100; i++) fake.emit("styledata");
    });
    expect(fake.state.counts.setData.get("category-results-source")).toBe(uploads);
    expect(data().features[0].properties?.imageId).toBe("brand-marker-Q1");
    const oldImage = images[0];
    act(() => {
      fake.map.setStyle({} as never);
    });
    await act(async () => {
      oldImage.onload?.();
    });
    expect(fake.state.layers.has("category-results-layer")).toBe(false);
    reach.filtered = [{ id: "new", name: "New", coordinates: [9, 51] }];
    view.rerender(<CategoryResultMarkers />);
    await act(async () => {
      for (const img of images) img.onload?.();
    });
    expect(data().features[0].properties?.id).toBe("new");
    view.unmount();
  } finally {
    globalThis.Image = OriginalImage;
    reach.filtered = oldResults;
  }
});

it.each([false, true])(
  "restores surviving-source layers and retries failed marker images (transit=%s)",
  async (transit) => {
    const OriginalImage = globalThis.Image;
    const images: Array<{ onload: (() => void) | null; onerror: (() => void) | null }> = [];
    globalThis.Image = class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      src = "";
      constructor() {
        images.push(this);
      }
    } as unknown as typeof Image;
    reach.isTransitCategory = transit;
    transitStops = transit
      ? [{ id: "stop", name: "Stop", lat: 50, lng: 8, modes: ["bus"], provider: "test" }]
      : undefined;
    const sourceId = transit ? "transit-stops-source" : "category-results-source";
    const layerId = transit ? "transit-stops-layer" : "category-results-layer";
    const imageId = transit ? "transit-marker-bus" : "category-marker-restaurant";
    let view: ReturnType<typeof render> | undefined;
    try {
      fake.map.setStyle({} as never);
      useCategorySearchStore.setState({ activeCategory: "restaurant" });
      view = render(<CategoryResultMarkers />);
      const source = fake.map.getSource(sourceId);
      await act(async () => {
        images[0].onerror?.();
      });
      const attempts = images.length;
      await act(async () => {
        fake.emit("styledata");
      });
      expect(images.length).toBe(attempts + 1);
      await act(async () => {
        images.at(-1)?.onload?.();
      });
      expect(fake.map.hasImage(imageId)).toBe(true);
      expect(fake.map.getLayer(layerId)).toBeDefined();
      const uploads = fake.state.counts.setData.get(sourceId) ?? 0;
      await act(async () => {
        fake.map.removeLayer(layerId);
        fake.emit("styledata");
      });
      expect(fake.map.getLayer(layerId)).toBeDefined();
      expect(fake.map.getSource(sourceId)).toBe(source);
      expect(fake.state.counts.setData.get(sourceId) ?? 0).toBe(uploads);
    } finally {
      view?.unmount();
      globalThis.Image = OriginalImage;
      reach.isTransitCategory = false;
      transitStops = undefined;
    }
  },
);

it("keeps every result in the source while small icons and names yield to collisions", async () => {
  fake.map.setStyle({} as never);
  fake.map.addImage("category-marker-restaurant", {} as never);
  reach.filtered = [
    { id: "one", name: "One", coordinates: [8, 50] },
    { id: "two", name: "Two", coordinates: [8.001, 50] },
  ];
  useCategorySearchStore.setState({ activeCategory: "restaurant", hoveredCategoryPlaceId: null });
  const view = render(<CategoryResultMarkers />);
  await act(async () => {});

  const data = fake.state.sources.get("category-results-source")?.data as GeoJSON.FeatureCollection;
  expect(data.features.map((feature) => feature.properties?.id)).toEqual(["one", "two"]);
  const icon = fake.state.layers.get("category-results-layer") as {
    layout: Record<string, unknown>;
  };
  const label = fake.state.layers.get("category-results-labels") as {
    minzoom: number;
    layout: Record<string, unknown>;
  };
  expect(icon.layout["icon-size"]).toEqual([
    "interpolate",
    ["linear"],
    ["zoom"],
    10,
    0.45,
    14,
    0.6,
    17,
    0.85,
  ]);
  expect(icon.layout["icon-allow-overlap"]).toBe(false);
  expect(icon.layout["icon-ignore-placement"]).toBe(false);
  expect(label.minzoom).toBe(15);
  expect(label.layout["text-allow-overlap"]).toBe(false);
  expect(label.layout["text-ignore-placement"]).toBe(false);
  view.unmount();
  reach.filtered = [result];
});

it("keeps the selected result out of the ordinary layers through hover and style replacement", async () => {
  const OriginalImage = globalThis.Image;
  const images: Array<{ onload: (() => void) | null }> = [];
  globalThis.Image = class {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    src = "";
    constructor() {
      images.push(this);
    }
  } as unknown as typeof Image;
  let view: ReturnType<typeof render> | undefined;
  try {
    fake.map.setStyle({} as never);
    fake.map.addImage("category-marker-restaurant", {} as never);
    const places = [
      { id: "osm:node/1", name: "One", coordinates: [8, 50] as [number, number] },
      { id: "osm:node/2", name: "Two", coordinates: [8.001, 50] as [number, number] },
    ];
    reach.filtered = places;
    useCategorySearchStore.setState({ activeCategory: "restaurant", hoveredCategoryPlaceId: null });
    usePlaceStore.setState({ selectedPlace: categoryPlaceToPlace(places[0]) });
    view = render(<CategoryResultMarkers />);
    await act(async () => {});

    const filter = ["all", ["!=", ["get", "id"], "osm:node/1"], ["!=", ["get", "id"], ""]];
    expect(fake.state.filters.get("category-results-layer")).toEqual(filter);
    expect(fake.state.filters.get("category-results-labels")).toEqual(filter);
    const uploads = fake.state.counts.setData.get("category-results-source") ?? 0;
    act(() => useCategorySearchStore.getState().setHoveredCategoryPlaceId("osm:node/2"));
    const hoveredFilter = [
      "all",
      ["!=", ["get", "id"], "osm:node/1"],
      ["!=", ["get", "id"], "osm:node/2"],
    ];
    expect(fake.state.filters.get("category-results-layer")).toEqual(hoveredFilter);
    expect(fake.state.counts.setData.get("category-results-source") ?? 0).toBe(uploads);
    act(() => fake.map.setStyle({} as never));
    await act(async () => images.at(-1)?.onload?.());
    expect(fake.state.filters.get("category-results-layer")).toEqual(hoveredFilter);
    act(() => useCategorySearchStore.getState().setHoveredCategoryPlaceId(null));
    expect(fake.state.filters.get("category-results-layer")).toEqual(filter);
  } finally {
    view?.unmount();
    usePlaceStore.setState({ selectedPlace: null });
    reach.filtered = [result];
    globalThis.Image = OriginalImage;
  }
});

it("waits for style readiness if an image finishes while the style is loading", async () => {
  const OriginalImage = globalThis.Image;
  const images: Array<{ onload: (() => void) | null }> = [];
  globalThis.Image = class {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    src = "";
    constructor() {
      images.push(this);
    }
  } as unknown as typeof Image;
  try {
    fake.map.setStyle({} as never);
    useCategorySearchStore.setState({ activeCategory: "restaurant" });
    const view = render(<CategoryResultMarkers />);
    fake.state.styleLoaded = false;
    await act(async () => images[0].onload?.());
    expect(fake.state.layers.has("category-results-layer")).toBe(false);
    fake.state.styleLoaded = true;
    await act(async () => fake.emit("styledata"));
    await act(async () => images.at(-1)?.onload?.());
    expect(fake.state.layers.has("category-results-layer")).toBe(true);
    view.unmount();
  } finally {
    fake.state.styleLoaded = true;
    globalThis.Image = OriginalImage;
  }
});

it("opens full result details from focused and ordinary markers", async () => {
  fake.map.setStyle({} as never);
  fake.map.addImage("category-marker-cafes", {} as never);
  const place = {
    id: "osm:node/51",
    name: "Cafe",
    coordinates: [8, 50] as [number, number],
    osmTags: { wheelchair: "yes" },
    provenance: [{ sourceId: "osm", dataset: "OpenStreetMap" }],
  };
  reach.filtered = [place];
  useCategorySearchStore.setState({ activeCategory: "cafes", hoveredCategoryPlaceId: place.id });
  usePlaceStore.setState({ selectedPlace: null });
  const view = render(<CategoryResultMarkers />);
  await act(async () => {});

  const pinHook = usePinMarker as unknown as ReturnType<typeof vi.fn>;
  const onPinClick = pinHook.mock.calls.at(-1)?.[4] as (() => void) | undefined;
  expect(onPinClick).toBeTypeOf("function");
  act(() => onPinClick?.());
  expect(usePlaceStore.getState().selectedPlace).toMatchObject({
    id: place.id,
    osmTags: place.osmTags,
    provenance: place.provenance,
  });
  act(() => usePlaceStore.setState({ selectedPlace: null }));
  fake.setRenderedFeatures("category-results-layer", [
    { properties: { id: place.id }, layer: { id: "category-results-layer" } } as never,
  ]);
  act(() => fake.emit("click", { point: { x: 0, y: 0 } }));
  expect(usePlaceStore.getState().selectedPlace).toMatchObject({
    id: place.id,
    osmTags: place.osmTags,
    provenance: place.provenance,
  });
  view.unmount();
  reach.filtered = [result];
  usePlaceStore.setState({ selectedPlace: null });
});

it("keeps hover while the pointer crosses a focused pin and clears it after leaving", async () => {
  fake.map.setStyle({} as never);
  fake.map.addImage("category-marker-restaurant", {} as never);
  reach.filtered = [{ id: "osm:node/1", name: "One", coordinates: [8, 50] }];
  useCategorySearchStore.setState({
    activeCategory: "restaurant",
    hoveredCategoryPlaceId: "osm:node/1",
  });
  fake.state.projectedPoint = { x: 30, y: 30 };
  fake.setRenderedFeatures("category-results-layer", []);
  const view = render(<CategoryResultMarkers />);
  await act(async () => {});
  act(() => fake.emit("mousemove", { point: { x: 30, y: 14 } }));
  expect(useCategorySearchStore.getState().hoveredCategoryPlaceId).toBe("osm:node/1");
  act(() => fake.emit("mousemove", { point: { x: 100, y: 100 } }));
  expect(useCategorySearchStore.getState().hoveredCategoryPlaceId).toBeNull();
  view.unmount();
  reach.filtered = [result];
});

it("opens and hovers a visible name when its icon did not place", async () => {
  fake.map.setStyle({} as never);
  fake.map.addImage("category-marker-restaurant", {} as never);
  const place = {
    id: "osm:node/90",
    name: "Visible label",
    coordinates: [8, 50] as [number, number],
    osmTags: { wheelchair: "yes" },
  };
  reach.filtered = [place];
  usePlaceStore.setState({ selectedPlace: null });
  useCategorySearchStore.setState({ activeCategory: "restaurant", hoveredCategoryPlaceId: null });
  const view = render(<CategoryResultMarkers />);
  await act(async () => {});
  fake.setRenderedFeatures("category-results-layer", []);
  fake.setRenderedFeatures("category-results-labels", [
    { properties: { id: place.id }, layer: { id: "category-results-labels" } } as never,
  ]);

  act(() => fake.emit("mousemove", { point: { x: 100, y: 100 } }));
  expect(useCategorySearchStore.getState().hoveredCategoryPlaceId).toBe(place.id);
  act(() => fake.emit("click", { point: { x: 100, y: 100 } }));
  expect(usePlaceStore.getState().selectedPlace).toMatchObject({
    id: place.id,
    osmTags: place.osmTags,
  });
  view.unmount();
  reach.filtered = [result];
  usePlaceStore.setState({ selectedPlace: null });
});

it("keeps hover over the focused name outside the pin symbol", async () => {
  fake.map.setStyle({} as never);
  fake.map.addImage("category-marker-restaurant", {} as never);
  reach.filtered = [{ id: "osm:node/1", name: "Long focused label", coordinates: [8, 50] }];
  useCategorySearchStore.setState({
    activeCategory: "restaurant",
    hoveredCategoryPlaceId: "osm:node/1",
  });
  fake.setRenderedFeatures("category-results-layer", []);
  fake.setRenderedFeatures("category-results-labels", []);
  const marker = document.createElement("div");
  marker.dataset.openmapxPinMarker = "";
  const name = document.createElement("span");
  marker.appendChild(name);
  const view = render(<CategoryResultMarkers />);
  await act(async () => {});

  act(() => fake.emit("mousemove", { point: { x: 150, y: 14 }, originalEvent: { target: name } }));
  expect(useCategorySearchStore.getState().hoveredCategoryPlaceId).toBe("osm:node/1");
  act(() => fake.emit("mousemove", { point: { x: 150, y: 14 } }));
  expect(useCategorySearchStore.getState().hoveredCategoryPlaceId).toBeNull();
  view.unmount();
  reach.filtered = [result];
});

it("does not register a stale marker image after the category changes", async () => {
  const OriginalImage = globalThis.Image;
  const images: Array<{ onload: (() => void) | null }> = [];
  globalThis.Image = class {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    src = "";
    constructor() {
      images.push(this);
    }
  } as unknown as typeof Image;
  let view: ReturnType<typeof render> | undefined;
  try {
    fake.map.setStyle({} as never);
    useCategorySearchStore.setState({ activeCategory: "restaurant" });
    view = render(<CategoryResultMarkers />);
    act(() => useCategorySearchStore.setState({ activeCategory: "cafes" }));
    await act(async () => images[0].onload?.());
    expect(fake.map.hasImage("category-marker-restaurant")).toBe(false);
    await act(async () => images.at(-1)?.onload?.());
    expect(fake.map.hasImage("category-marker-cafes")).toBe(true);
  } finally {
    view?.unmount();
    globalThis.Image = OriginalImage;
  }
});

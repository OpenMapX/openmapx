import { useCategorySearchStore } from "@openmapx/core";
import { act, render } from "@testing-library/react";
import { expect, it, vi } from "vitest";
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
  useMap: () => ({ mapRef, mapReady: true, styleVersion: 0 }),
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

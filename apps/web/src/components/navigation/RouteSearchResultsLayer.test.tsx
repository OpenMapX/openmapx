// @vitest-environment jsdom
import type { AlongRoutePoi, CategoryPlace } from "@openmapx/core";
import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", async () => {
  const { createTranslator } = await vi.importActual<typeof import("next-intl")>("next-intl");
  const { default: messages } = await import("@openmapx/i18n/locales/en.json");
  const translate = createTranslator({ locale: "en", messages, namespace: "navigation" });
  return { useTranslations: () => translate };
});

const fixtures = vi.hoisted(() => ({
  loadBrand: vi.fn(),
  rendered: vi.fn(),
  assetReceipts: [{ sourceId: "commons-file", name: "Logo author" }],
  mapRef: { current: null as unknown },
  styleVersion: 1,
}));
vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ mapRef: fixtures.mapRef, mapReady: true, styleVersion: fixtures.styleVersion }),
}));
vi.mock("@/components/map/CategoryResultMarkers", () => ({
  brandImageId: (qid: string) => `brand-marker-${qid}`,
  loadBrandMarkerImage: fixtures.loadBrand,
  loadedBrandMarkerContributors: () => fixtures.assetReceipts,
}));

vi.mock("@/integration-api/overlay/useRenderedMapAttributions", () => ({
  useRenderedMapAttributions: fixtures.rendered,
}));

import type { MapGeoJSONFeature } from "maplibre-gl";
import { INTERACTIVE_LAYER_IDS } from "@/integration-api/map/interactiveLayers";
import { unregisterLayerSlot } from "@/integration-api/map/layerStack";
import { createFakeMap, type FakeMap } from "@/test";
import { RouteSearchResultsLayer } from "./RouteSearchResultsLayer";

let fake: FakeMap;

const results = [
  { place: { id: "lidl", coordinates: [13, 52] }, detourSeconds: 120 },
] as AlongRoutePoi<CategoryPlace>[];
const props = { results, iconPath: "M0 0", categoryKey: "brand:Q151954", onSelect: vi.fn() };
function drawnFeatures() {
  const data = fake.state.sources.get("route-search-source")?.data as
    | { features: { properties: Record<string, string> }[] }
    | undefined;
  return data?.features ?? [];
}
function lastProperties() {
  const properties = drawnFeatures()[0]?.properties;
  if (!properties) throw new Error("Expected published route-search feature");
  return properties;
}
function lastOptions() {
  const options = fixtures.rendered.mock.calls.at(-1)?.[3] as
    | {
        resolveFeatureContributors: (feature: {
          layer: { id: string };
          properties: Record<string, string>;
        }) => unknown;
      }
    | undefined;
  if (!options) throw new Error("Expected rendered receipt registration");
  return options;
}
/**
 * Stands in for the logo fetch: a successful load installs the image in the
 * map's current style unless the caller has moved on, as the real loader does.
 */
function loadLogo(result: Promise<boolean> | boolean = true) {
  return async (...args: unknown[]) => {
    const [map, qid, isCurrent] = args as [FakeMap["map"], string, () => boolean];
    const loaded = await result;
    if (!loaded || !isCurrent()) return false;
    map.addImage(`brand-marker-${qid}`, {} as never);
    return true;
  };
}
function lastImage() {
  return drawnFeatures()[0]?.properties.imageId;
}
/** Clicks the map with the result's pin, its label, or both under the pointer. */
function clickResult(layers: string[]) {
  for (const layer of layers) {
    fake.setRenderedFeatures(layer, [
      { properties: { id: "lidl" }, layer: { id: layer } } as unknown as MapGeoJSONFeature,
    ]);
  }
  act(() => fake.emit("click", { point: { x: 0, y: 0 } }));
}
beforeEach(() => {
  vi.clearAllMocks();
  fixtures.styleVersion = 1;
  fixtures.assetReceipts = [{ sourceId: "commons-file", name: "Logo author" }];
  fake = createFakeMap({ styleLoaded: true });
  fixtures.mapRef.current = fake.map;
  unregisterLayerSlot("route-search-layer");
  unregisterLayerSlot("route-search-labels");
});
describe("RouteSearchResultsLayer brand pins", () => {
  it("separates rendered pin coordinate/logo receipts from detour text receipts", async () => {
    fixtures.loadBrand.mockImplementation(loadLogo());
    const coordinate = { sourceId: "poi", name: "Coordinate supplier" };
    const seconds = { sourceId: "routing", name: "Detour duration" };
    const hidden = { sourceId: "hidden", name: "Hidden name/metres" };
    const poi = {
      ...results[0],
      place: {
        ...results[0].place,
        contributors: [hidden],
        fieldContributors: { coordinates: [coordinate], name: [hidden] },
      },
      detour: {
        kind: "network",
        id: "lidl",
        seconds: 120,
        meters: 500,
        provider: "routing",
        access: { kind: "coordinate", coordinates: [13, 52] },
        waypoints: [],
        fieldContributors: { seconds: [seconds], meters: [hidden] },
      },
    } as AlongRoutePoi<CategoryPlace>;
    render(<RouteSearchResultsLayer {...props} results={[poi]} brandQid="Q151954" />);
    await waitFor(() => expect(lastImage()).toBe("brand-marker-Q151954"));
    const properties = lastProperties();
    expect(JSON.parse(properties._mapMarkerAttributions)).toEqual([coordinate]);
    expect(JSON.parse(properties._mapLabelAttributions)).toEqual([coordinate, seconds]);
    const layers = fixtures.rendered.mock.calls.at(-1)?.[1];
    const options = lastOptions();
    expect(layers).toEqual(["route-search-layer", "route-search-labels"]);
    expect(
      options.resolveFeatureContributors({ layer: { id: "route-search-layer" }, properties }),
    ).toEqual([coordinate, ...fixtures.assetReceipts]);
    expect(
      options.resolveFeatureContributors({ layer: { id: "route-search-labels" }, properties }),
    ).toEqual([coordinate, seconds]);
  });
  it("does not borrow hidden place receipts for authoritative empty coordinates or unknown text", () => {
    const hidden = { sourceId: "hidden", name: "Hidden name" };
    render(
      <RouteSearchResultsLayer
        {...props}
        results={[
          {
            ...results[0],
            place: {
              ...results[0].place,
              contributors: [hidden],
              fieldContributors: { coordinates: [] },
            },
            detourPending: true,
          },
        ]}
      />,
    );
    const properties = lastProperties();
    expect(JSON.parse(properties._mapMarkerAttributions)).toEqual([]);
    expect(JSON.parse(properties._mapLabelAttributions)).toEqual([]);
  });
  it("follows the captured receipt of a same-QID image replaced after feature publication", async () => {
    fixtures.loadBrand.mockImplementation(loadLogo());
    render(<RouteSearchResultsLayer {...props} brandQid="Q151954" />);
    await waitFor(() => expect(lastImage()).toBe("brand-marker-Q151954"));
    const properties = lastProperties();
    const options = lastOptions();
    fixtures.assetReceipts = [{ sourceId: "commons-file", name: "Replacement author" }];
    expect(
      options.resolveFeatureContributors({ layer: { id: "route-search-layer" }, properties }),
    ).toEqual(fixtures.assetReceipts);
  });
  it("selects once when the pin and label are both hit", () => {
    const onSelect = vi.fn();
    render(<RouteSearchResultsLayer {...props} onSelect={onSelect} />);
    clickResult(["route-search-layer", "route-search-labels"]);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
  it("keeps text labels selectable after separating painted channels", () => {
    const onSelect = vi.fn();
    render(<RouteSearchResultsLayer {...props} onSelect={onSelect} />);
    clickResult(["route-search-labels"]);
    expect(onSelect).toHaveBeenCalledWith(results[0]);
  });
  it("labels unknown and unreachable detours without short geometric minutes", () => {
    const unknown = {
      ...results[0],
      detour: {
        id: "lidl",
        kind: "unknown",
        access: { kind: "coordinate", coordinates: [13, 52] },
        waypoints: [],
      },
    } as AlongRoutePoi<CategoryPlace>;
    const { rerender } = render(<RouteSearchResultsLayer {...props} results={[unknown]} />);
    const label = () => drawnFeatures()[0]?.properties.label;
    expect(label()).toBe("Unknown detour");
    rerender(
      <RouteSearchResultsLayer
        {...props}
        results={[{ ...unknown, detour: { ...unknown.detour!, kind: "unreachable" } }]}
      />,
    );
    expect(label()).toBe("Unreachable");
    rerender(<RouteSearchResultsLayer {...props} />);
    expect(label()).toBe("~+2 min");
  });
  it("publishes a loaded logo while the current style is still loading tiles", async () => {
    fake.state.styleLoaded = false;
    fixtures.loadBrand.mockImplementation(loadLogo());
    render(<RouteSearchResultsLayer {...props} brandQid="Q151954" />);
    await waitFor(() => expect(lastImage()).toBe("brand-marker-Q151954"));
  });
  it("keeps the category fallback when the logo fails", async () => {
    fixtures.loadBrand.mockImplementation(loadLogo(false));
    render(<RouteSearchResultsLayer {...props} brandQid="Q151954" />);
    await act(async () => {});
    expect(lastImage()).toBe("route-search-pin-brand:Q151954");
  });
  it("ignores a logo finishing after a new brand selection", async () => {
    let finish!: (loaded: boolean) => void;
    const first = new Promise<boolean>((resolve) => {
      finish = resolve;
    });
    fixtures.loadBrand.mockImplementationOnce(loadLogo(first)).mockImplementation(loadLogo(false));
    const { rerender } = render(<RouteSearchResultsLayer {...props} brandQid="Q151954" />);
    rerender(<RouteSearchResultsLayer {...props} categoryKey="brand:Q110" brandQid="Q110" />);
    await act(async () => {
      finish(true);
    });
    expect(lastImage()).toBe("route-search-pin-brand:Q110");
    expect(fake.map.hasImage("brand-marker-Q151954")).toBe(false);
  });

  it("shows the brand logo again after a style switch", async () => {
    fixtures.loadBrand.mockImplementation(loadLogo());
    const { rerender } = render(<RouteSearchResultsLayer {...props} brandQid="Q151954" />);
    await waitFor(() => expect(lastImage()).toBe("brand-marker-Q151954"));

    // The style switch drops every image and rebuilds the group before React
    // learns the new style version; the reload must still reach the pins.
    let finish!: (loaded: boolean) => void;
    fixtures.loadBrand.mockImplementationOnce(
      loadLogo(
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
      ),
    );
    act(() => fake.map.setStyle({} as never));
    fixtures.styleVersion = 2;
    rerender(<RouteSearchResultsLayer {...props} brandQid="Q151954" />);
    expect(lastImage()).toBe("route-search-pin-brand:Q151954");
    await act(async () => {
      finish(true);
    });
    expect(lastImage()).toBe("brand-marker-Q151954");
  });
});

describe("RouteSearchResultsLayer tap ownership", () => {
  it("claims its pins and labels as interactive while mounted", () => {
    const view = render(<RouteSearchResultsLayer {...props} />);
    expect(INTERACTIVE_LAYER_IDS.has("route-search-layer")).toBe(true);
    expect(INTERACTIVE_LAYER_IDS.has("route-search-labels")).toBe(true);
    view.unmount();
    expect(INTERACTIVE_LAYER_IDS.has("route-search-layer")).toBe(false);
    expect(INTERACTIVE_LAYER_IDS.has("route-search-labels")).toBe(false);
  });
});

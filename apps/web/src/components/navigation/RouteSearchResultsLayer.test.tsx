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
  publish: vi.fn(),
  loadBrand: vi.fn(),
  rendered: vi.fn(),
  assetReceipts: [{ sourceId: "commons-file", name: "Logo author" }],
  map: {
    getSource: vi.fn(),
    hasImage: vi.fn(() => false),
    addImage: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    isStyleLoaded: vi.fn(() => true),
  },
  styleVersion: 1,
}));
vi.mock("@/integration-api/map/MapContext", () => {
  const mapRef = { current: fixtures.map };
  return { useMap: () => ({ mapRef, mapReady: true, styleVersion: fixtures.styleVersion }) };
});
vi.mock("@/integration-api/map/useGeoJsonSourceDataBridge", () => ({
  useGeoJsonSourceDataBridge: () => ({ publish: fixtures.publish }),
}));
vi.mock("@/components/map/CategoryResultMarkers", () => ({
  brandImageId: (qid: string) => `brand-marker-${qid}`,
  loadBrandMarkerImage: fixtures.loadBrand,
  loadedBrandMarkerContributors: () => fixtures.assetReceipts,
}));

vi.mock("@/integration-api/overlay/useRenderedMapAttributions", () => ({
  useRenderedMapAttributions: fixtures.rendered,
}));

import { RouteSearchResultsLayer } from "./RouteSearchResultsLayer";

const results = [
  { place: { id: "lidl", coordinates: [13, 52] }, detourSeconds: 120 },
] as AlongRoutePoi<CategoryPlace>[];
const props = { results, iconPath: "M0 0", categoryKey: "brand:Q151954", onSelect: vi.fn() };
type PublishedBatch = { data: { features: { properties: Record<string, string> }[] } }[];
function lastProperties() {
  const batch = fixtures.publish.mock.calls.at(-1)?.[0] as PublishedBatch | undefined;
  const properties = batch?.[0].data.features[0]?.properties;
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
function lastImage() {
  const batch = fixtures.publish.mock.calls.at(-1)?.[0] as
    | { data: { features: { properties: { imageId: string } }[] } }[]
    | undefined;
  return batch?.[0].data.features[0]?.properties.imageId;
}
beforeEach(() => {
  vi.clearAllMocks();
  fixtures.styleVersion = 1;
  fixtures.assetReceipts = [{ sourceId: "commons-file", name: "Logo author" }];
  fixtures.map.getSource.mockReturnValue({});
  fixtures.map.isStyleLoaded.mockReturnValue(true);
});
describe("RouteSearchResultsLayer brand pins", () => {
  it("separates rendered pin coordinate/logo receipts from detour text receipts", async () => {
    fixtures.loadBrand.mockResolvedValue(true);
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
    fixtures.loadBrand.mockResolvedValue(true);
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
    for (const [event, , handler] of fixtures.map.on.mock.calls) {
      if (event === "click" && typeof handler === "function")
        handler({ features: [{ properties: { id: "lidl" } }] });
    }
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
  it("keeps text labels selectable after separating painted channels", () => {
    const onSelect = vi.fn();
    render(<RouteSearchResultsLayer {...props} onSelect={onSelect} />);
    const handler = fixtures.map.on.mock.calls.find(
      (call) =>
        call[0] === "click" && Array.isArray(call[1]) && call[1].includes("route-search-labels"),
    )?.[2];
    if (typeof handler !== "function") throw new Error("Expected selectable route-search labels");
    handler({ features: [{ properties: { id: "lidl" } }] });
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
    const label = () =>
      (
        fixtures.publish.mock.calls.at(-1)?.[0] as
          | { data: { features: { properties: { label: string } }[] } }[]
          | undefined
      )?.[0].data.features[0].properties.label;
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
  it("publishes the selected brand logo after it loads", async () => {
    fixtures.loadBrand.mockResolvedValue(true);
    render(<RouteSearchResultsLayer {...props} brandQid="Q151954" />);
    await waitFor(() => expect(lastImage()).toBe("brand-marker-Q151954"));
  });
  it("publishes a loaded logo while the current style is still loading tiles", async () => {
    fixtures.map.isStyleLoaded.mockReturnValue(false);
    fixtures.loadBrand.mockResolvedValue(true);
    render(<RouteSearchResultsLayer {...props} brandQid="Q151954" />);
    await waitFor(() => expect(lastImage()).toBe("brand-marker-Q151954"));
  });
  it("keeps the category fallback when the logo fails", async () => {
    fixtures.loadBrand.mockResolvedValue(false);
    render(<RouteSearchResultsLayer {...props} brandQid="Q151954" />);
    await act(async () => {});
    expect(lastImage()).toBe("route-search-pin-brand:Q151954");
  });
  it("ignores a logo finishing after a new brand selection", async () => {
    let finish!: (loaded: boolean) => void;
    let calls = 0;
    fixtures.loadBrand.mockImplementation(() => {
      if (calls++ > 0) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        finish = resolve;
      });
    });
    const { rerender } = render(<RouteSearchResultsLayer {...props} brandQid="Q151954" />);
    rerender(<RouteSearchResultsLayer {...props} categoryKey="brand:Q110" brandQid="Q110" />);
    await act(async () => {
      finish(true);
    });
    expect(lastImage()).toBe("route-search-pin-brand:Q110");
  });

  it("ignores a logo finishing after a style replacement", async () => {
    let finish!: (loaded: boolean) => void;
    let calls = 0;
    fixtures.loadBrand.mockImplementation(() => {
      if (calls++ > 0) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        finish = resolve;
      });
    });
    const { rerender } = render(<RouteSearchResultsLayer {...props} brandQid="Q151954" />);
    fixtures.styleVersion = 2;
    rerender(<RouteSearchResultsLayer {...props} brandQid="Q151954" />);
    await act(async () => {
      finish(true);
    });
    expect(lastImage()).toBe("route-search-pin-brand:Q151954");
  });
});

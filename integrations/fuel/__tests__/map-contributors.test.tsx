import type { DataSourceResult } from "@openmapx/core";
import { useDataSourceStore } from "@openmapx/core";
import { expect, it, vi } from "vitest";
import { DataSourceLayer } from "@/components/map/layers/DataSourceLayer";
import { useMapAttributionStore } from "@/integration-api/overlay/mapAttributionStore";
import { act, createFakeMap, render } from "@/test";
import { mapFuelStationToResult } from "../mapper.js";

// This production mapper also imports core/server for schedule evaluation.
// Integration frontend tests run in Vitest and stay outside the main Next.js
// type graph, avoiding server-only Node ambient declarations in that graph.
const fake = createFakeMap({ styleLoaded: true });
const mapRef = { current: fake.map };
const rows: DataSourceResult[] = [];
const sources = {
  sources: [
    {
      id: "sample",
      minZoom: 5,
      filters: [],
      markerStyle: { type: "circle", defaultColor: "red", variantColors: {}, inactiveOpacity: 0.5 },
    },
  ],
};
vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ mapRef, mapReady: true, styleVersion: 0 }),
}));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("@/components/panels/place/useDataSourceI18nResolver", () => ({
  useDataSourceI18nResolver: () => () => "",
}));
vi.mock("@/hooks/usePinMarker", () => ({ usePinMarker: () => {} }));
vi.mock("@openmapx/integration-framework/react", () => ({
  useIntegrationRegistry: () => ({ get: () => undefined }),
}));
vi.mock("@openmapx/core", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useDataSources: () => ({ data: sources }),
  useDataSourceSearch: () => ({ data: rows, attributions: [] }),
  useDataSourceMapContext: () => ({ data: undefined }),
}));

it("credits actual fuel marker channels without hidden NSI/catalogue branding", () => {
  vi.useFakeTimers();
  fake.state.zoom = 12;
  useMapAttributionStore.setState({ byLayer: {} });
  const station = mapFuelStationToResult({
    id: "fuel:aral",
    name: "Feed station",
    brand: "Aral",
    coordinates: [8, 50],
    products: [],
    productsComplete: false,
    sources: ["feed"],
    attributions: [{ sourceId: "feed", name: "Actual fuel feed" }],
  });
  expect(station.contributors?.some((receipt) => receipt.sourceId !== "feed")).toBe(true);
  rows.push(station);
  useDataSourceStore.setState({ activeSource: "sample", filters: {}, viewportZoom: 12 });
  const view = render(<DataSourceLayer />);
  try {
    const uploaded = fake.state.sources.get("ds-sample")?.data as GeoJSON.FeatureCollection;
    fake.setRenderedFeatures("ds-sample-markers", uploaded.features as never);
    act(() => {
      fake.emit("render");
      vi.advanceTimersByTime(250);
    });
    const html = Object.values(useMapAttributionStore.getState().byLayer)
      .flat()
      .map((entry) => entry.fullHtml)
      .join(" ");
    expect(html).toContain("Actual fuel feed");
    expect(html).not.toContain("Name Suggestion Index");
    expect(html).not.toContain("Wikidata");
  } finally {
    view.unmount();
    rows.length = 0;
    useDataSourceStore.setState({ activeSource: null, filters: {} });
    vi.useRealTimers();
  }
});

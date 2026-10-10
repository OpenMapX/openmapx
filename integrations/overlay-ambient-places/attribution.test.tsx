import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useMapAttributionStore } from "@/integration-api/overlay/mapAttributionStore";
import manifest from "./manifest.json";
import { AmbientPlacesLayer } from "./map-layer";
import { useAmbientPlacesStore } from "./store";

vi.mock("@openmapx/integration-framework/react", () => ({
  useIntegrationRegistry: () => ({
    get: () => manifest,
    findDataSource: (id: string) => manifest.dataSources.find((source) => source.sourceId === id),
  }),
}));
vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ mapRef: { current: null }, mapReady: false }),
}));
vi.mock("@/integration-api/map/useMapLayerGroup", () => ({ useMapLayerGroup: () => {} }));
vi.mock("@/integration-api/runtime/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: "http://fixture" }),
}));
vi.mock("@/lib/useExploreReachResults", () => {
  const result = { filtered: [] };
  return { useExploreReachResults: () => result };
});
vi.mock("next-intl", () => ({ useLocale: () => "de" }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useAmbientPlacesStore.setState({ manifest: null, panelOpen: false, layerVisible: true });
  useMapAttributionStore.setState({ byLayer: {} });
});
it("credits only published sources and clears credits when ambient places are hidden", async () => {
  const now = new Date().toISOString();
  const publication = {
    version: 1 as const,
    policyVersion: 2,
    generation: "11111111-1111-4111-8111-111111111111",
    publishedAt: now,
    region: {
      name: "Neuss",
      bounds: [6.58, 50.89, 7.07, 51.31] as [number, number, number, number],
    },
    placeCount: 1,
    enabled: true,
    sources: {
      osm: { region: "europe/germany", epoch: "one", publishedAt: now, count: 1 },
      overture: null,
    },
  };
  // The network is the only asynchronous boundary: source selection and the
  // attribution hook/store remain real so a missing hook export cannot hide.
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({ manifest: publication }) }),
  );
  useAmbientPlacesStore.setState({ manifest: publication, panelOpen: true, layerVisible: true });
  const view = render(<AmbientPlacesLayer />);
  const credits = () => Object.values(useMapAttributionStore.getState().byLayer).flat().join(" ");
  await waitFor(() => expect(credits()).toContain("OpenStreetMap contributors"));
  await waitFor(() => expect(useAmbientPlacesStore.getState().loading).toBe(false));
  expect(credits()).toContain("https://www.openstreetmap.org/copyright");
  expect(credits()).not.toContain("Overture");
  expect(credits()).not.toContain("Foursquare");

  act(() =>
    useAmbientPlacesStore.setState({
      manifest: {
        ...publication,
        sources: {
          ...publication.sources,
          overture: {
            region: "europe/germany",
            release: "2026-09-23.0",
            publishedAt: now,
            count: 1,
          },
        },
      },
    }),
  );
  await waitFor(() => expect(credits()).toContain("Overture Maps"));
  expect(credits()).toContain("OpenStreetMap contributors");
  expect(credits()).toContain("Data from Foursquare. Copyright 2024 Foursquare Labs, Inc.");
  expect(credits()).toContain("Apache 2.0");

  act(() => useAmbientPlacesStore.setState({ layerVisible: false }));
  await waitFor(() => expect(credits()).toBe(""));
  view.unmount();
});

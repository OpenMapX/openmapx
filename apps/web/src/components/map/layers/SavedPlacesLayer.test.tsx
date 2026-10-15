import { PANEL, type SavedPlace } from "@openmapx/core";
import { act, render } from "@testing-library/react";
import type { MapGeoJSONFeature } from "maplibre-gl";
import { afterEach, expect, it, vi } from "vitest";
import { useMapAttributionStore } from "@/integration-api/overlay/mapAttributionStore";
import { createFakeMap } from "@/test";
import { SavedPlacesLayer } from "./SavedPlacesLayer";

const fields = {
  name: [{ sourceId: "name", name: "Hidden name receipt" }],
  lat: [{ sourceId: "coordinate", name: "Acquired coordinate receipt" }],
  lng: [],
};
const places: SavedPlace[] = [
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
const fake = createFakeMap();
const mapRef = { current: fake.map };
vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ mapRef, mapReady: true, styleVersion: 0 }),
}));
vi.mock("@openmapx/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openmapx/core")>()),
  useSavedListPlaces: () => ({ data: places }),
  useSavedPlacesStore: (select: (state: unknown) => unknown) => select({ selectedListId: "list" }),
  useSidebarStore: (select: (state: unknown) => unknown) =>
    select({ activeSidebarId: PANEL.SAVED }),
}));
afterEach(() => vi.useRealTimers());
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
  fake.setRenderedFeatures("saved-places-layer", data.features as MapGeoJSONFeature[]);
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

import { useImportedGeometryStore } from "@openmapx/core";
import { act, render } from "@testing-library/react";
import type { MapGeoJSONFeature } from "maplibre-gl";
import { afterEach, expect, it, vi } from "vitest";
import { useMapAttributionStore } from "@/integration-api/overlay/mapAttributionStore";
import { parseGeoFile } from "@/lib/importGeoFile";
import { createFakeMap } from "@/test";
import { ImportedGeometryLayer } from "./ImportedGeometryLayer";

const fake = createFakeMap({ styleLoaded: true });
const mapRef = { current: fake.map };
const fitBounds = vi.fn();
vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ mapRef, fitBounds, mapReady: true, styleVersion: 0 }),
}));
it("does not republish or reframe an import on 100 style events and restores a replaced source", () => {
  const imported = {
    name: "line",
    geojson: {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: {
            type: "LineString",
            coordinates: [
              [8, 50],
              [9, 51],
            ],
          },
        },
      ],
    },
  };
  useImportedGeometryStore.setState({ imported: imported as never });
  const view = render(<ImportedGeometryLayer />);
  act(() => {
    for (let i = 0; i < 100; i++) fake.emit("styledata");
  });
  expect(fake.state.counts.setData.get("imported-geometry-source") ?? 0).toBe(0);
  expect(fitBounds).toHaveBeenCalledTimes(1);
  act(() => {
    fake.map.setStyle({} as never);
  });
  expect(fake.state.sources.get("imported-geometry-source")?.data).toEqual(imported.geojson);
  expect(fitBounds).toHaveBeenCalledTimes(1);
  act(() => {
    useImportedGeometryStore.setState({ imported: null });
  });
  expect(fake.state.sources.has("imported-geometry-source")).toBe(false);
  view.unmount();
});

afterEach(() => vi.useRealTimers());
it("publishes imported coordinate receipts only while their geometry is painted", () => {
  vi.useFakeTimers();
  useMapAttributionStore.setState({ byLayer: {} });
  const receipt = { sourceId: "import", name: "Original imported geometry" };
  const name = { sourceId: "name", name: "Unpainted name" };
  const geojson = parseGeoFile(
    "saved.geojson",
    JSON.stringify({
      type: "Feature",
      properties: { name: "Place", fieldContributors: { name: [name], lat: [receipt], lng: [] } },
      geometry: { type: "Point", coordinates: [8, 50] },
    }),
  );
  if (!geojson) throw new Error("Import rejected");
  useImportedGeometryStore.setState({ imported: { name: "saved.geojson", geojson } });
  const view = render(<ImportedGeometryLayer />);
  fake.setRenderedFeatures("imported-geometry-point", geojson.features as MapGeoJSONFeature[]);
  act(() => {
    fake.emit("render");
    vi.advanceTimersByTime(250);
  });
  const html = () =>
    Object.values(useMapAttributionStore.getState().byLayer)
      .flat()
      .map((entry) => entry.fullHtml)
      .join(" ");
  expect(html()).toContain("Original imported geometry");
  expect(html()).not.toContain("Unpainted name");
  view.unmount();
  expect(html()).toBe("");
  expect(fake.state.sources.has("imported-geometry-source")).toBe(false);
  useImportedGeometryStore.setState({ imported: null });
});

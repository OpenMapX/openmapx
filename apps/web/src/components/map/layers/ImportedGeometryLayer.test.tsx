import { useImportedGeometryStore } from "@openmapx/core";
import { act, render } from "@testing-library/react";
import { expect, it, vi } from "vitest";
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

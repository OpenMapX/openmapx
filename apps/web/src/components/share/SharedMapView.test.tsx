import type { Attribution } from "@openmapx/mobility-core/attribution";
import { act, render, screen } from "@testing-library/react";
import type { MapGeoJSONFeature } from "maplibre-gl";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useMapAttributionStore } from "@/integration-api/overlay/mapAttributionStore";
import { createFakeMap } from "@/test";
import { SharedMapView } from "./SharedMapView";

let fake = createFakeMap();
const env = { styleProvider: "openmapx" };
const remove = vi.fn();
vi.mock("@/integration-api/runtime/EnvProvider", () => ({ useEnv: () => env }));
vi.mock("@mui/material/styles", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@mui/material/styles")>()),
  useColorScheme: () => ({ mode: "light" }),
}));
vi.mock("@/lib/map", () => ({
  baseMapVectorCredits: () => [],
  loadOpenMapXStyle: async () => ({}),
  loadMaptilerStyle: async () => ({}),
}));
vi.mock("@/lib/maplibreRuntime", () => ({
  loadMapLibreRuntime: async () => ({
    Map: function SharedMapConstructor() {
      return Object.assign(fake.map, { remove });
    },
  }),
}));
vi.mock("@/components/map/MapCredits", () => ({
  MapCredits: ({ attributions }: { attributions: Attribution[] }) => (
    <div data-testid="credits">{attributions.map((a) => a.name).join("|")}</div>
  ),
}));
beforeEach(() => {
  fake = createFakeMap();
  remove.mockClear();
});
afterEach(() => vi.useRealTimers());

it("retains coordinate receipts in the point generation and publishes locally only for rendered points", async () => {
  vi.useFakeTimers();
  useMapAttributionStore.setState({ byLayer: {} });
  const coordinate = { sourceId: "coordinate", name: "Original coordinate supplier" };
  const name = { sourceId: "name", name: "Name-only supplier" };
  const view = render(
    <SharedMapView
      points={[
        { lat: 50, lng: 8, fieldContributors: { name: [name], lat: [coordinate], lng: [] } },
      ]}
    />,
  );
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  act(() => fake.emit("load"));
  const data = fake.state.sources.get("shared-points-source")?.data as GeoJSON.FeatureCollection;
  expect(JSON.parse(data.features[0].properties?._mapAttributions)).toEqual([coordinate]);
  expect(screen.getByTestId("credits")).toHaveTextContent("");
  fake.setRenderedFeatures("shared-points-layer", data.features as MapGeoJSONFeature[]);
  act(() => {
    fake.emit("render");
    vi.advanceTimersByTime(250);
  });
  expect(screen.getByTestId("credits")).toHaveTextContent("Original coordinate supplier");
  expect(screen.getByTestId("credits")).not.toHaveTextContent("Name-only supplier");
  expect(useMapAttributionStore.getState().byLayer).toEqual({});
  fake.setRenderedFeatures("shared-points-layer", []);
  act(() => {
    fake.emit("render");
    vi.advanceTimersByTime(250);
  });
  expect(screen.getByTestId("credits")).toHaveTextContent("");
  view.unmount();
  expect(remove).toHaveBeenCalledTimes(1);
  expect(fake.state.handlers.get("render")?.size ?? 0).toBe(0);
});

it("projects captured geometry spans and credits line-only viewport content locally", async () => {
  vi.useFakeTimers();
  const a = { sourceId: "a", name: "First segment supplier" };
  const b = { sourceId: "b", name: "Second segment supplier" };
  const text = { sourceId: "text", name: "Duration-only supplier" };
  const route = {
    geometry: [
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 3],
    ] as [number, number][],
    contributors: [text],
    fieldContributors: { duration: [text], geometry: [text] },
    geometryContributors: [
      { startIndex: 0, endIndex: 1, contributors: [a] },
      { startIndex: 2, endIndex: 3, contributors: [b] },
    ],
  };
  const view = render(<SharedMapView points={[]} route={route} />);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  act(() => fake.emit("load"));
  const data = fake.state.sources.get("shared-route-source")?.data as GeoJSON.FeatureCollection;
  expect(data.features).toHaveLength(3);
  expect(data.features.map((f) => JSON.parse(f.properties?._mapAttributions))).toEqual([
    [a],
    [],
    [b],
  ]);
  expect(data.features.map((f) => (f.geometry as GeoJSON.LineString).coordinates)).toEqual([
    [
      [0, 0],
      [1, 1],
    ],
    [
      [1, 1],
      [2, 2],
    ],
    [
      [2, 2],
      [3, 3],
    ],
  ]);
  const flush = () =>
    act(() => {
      fake.emit("render");
      vi.advanceTimersByTime(250);
    });
  fake.setRenderedFeatures("shared-route-line", [data.features[0]] as MapGeoJSONFeature[]);
  flush();
  expect(screen.getByTestId("credits")).toHaveTextContent("First segment supplier");
  expect(screen.getByTestId("credits")).not.toHaveTextContent("Second segment supplier");
  expect(screen.getByTestId("credits")).not.toHaveTextContent("Duration-only supplier");
  fake.setRenderedFeatures("shared-route-line", []);
  fake.setRenderedFeatures("shared-route-casing", [data.features[2]] as MapGeoJSONFeature[]);
  flush();
  expect(screen.getByTestId("credits")).toHaveTextContent("Second segment supplier");
  expect(screen.getByTestId("credits")).not.toHaveTextContent("First segment supplier");
  fake.setRenderedFeatures("shared-route-casing", []);
  flush();
  expect(screen.getByTestId("credits")).toHaveTextContent("");
  // Receipt refreshes do not reset the viewer's camera for unchanged geometry.
  const points: [] = [];
  view.rerender(<SharedMapView points={points} route={route} />);
  const fit = vi.spyOn(fake.map, "fitBounds");
  view.rerender(<SharedMapView points={points} route={{ ...route, contributors: [] }} />);
  expect(fit).not.toHaveBeenCalled();
  view.rerender(<SharedMapView points={[]} route={null} />);
  expect(
    (fake.state.sources.get("shared-route-source")?.data as GeoJSON.FeatureCollection).features,
  ).toEqual([]);
  expect(useMapAttributionStore.getState().byLayer).toEqual({});
  view.unmount();
  expect(fake.state.handlers.get("render")?.size ?? 0).toBe(0);
});

it("frames changed share content while source tiles are pending", async () => {
  const view = render(<SharedMapView points={[{ lat: 50, lng: 8 }]} />);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  act(() => fake.emit("load"));
  fake.state.styleLoaded = false;
  const fit = vi.spyOn(fake.map, "fitBounds");
  view.rerender(
    <SharedMapView
      points={[
        { lat: 51, lng: 9 },
        { lat: 52, lng: 10 },
      ]}
    />,
  );
  expect(fit).toHaveBeenCalledWith(
    [
      [9, 51],
      [10, 52],
    ],
    { padding: 60, duration: 0, maxZoom: 15 },
  );
  view.unmount();
});

it("installs initial shared content and restores it without waiting for tiles", async () => {
  fake.state.styleLoaded = false;
  const view = render(<SharedMapView points={[{ lat: 50, lng: 8 }]} />);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  const data = () =>
    fake.state.sources.get("shared-points-source")?.data as GeoJSON.FeatureCollection | undefined;
  expect(data()?.features[0].geometry).toEqual({ type: "Point", coordinates: [8, 50] });
  act(() => fake.map.setStyle({} as never));
  expect(data()?.features[0].geometry).toEqual({ type: "Point", coordinates: [8, 50] });
  expect(fake.map.getLayer("shared-points-layer")).toBeDefined();
  view.unmount();
  expect(fake.state.handlers.get("styledata")?.size ?? 0).toBe(0);
});

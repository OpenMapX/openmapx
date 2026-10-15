import type { Attribution } from "@openmapx/mobility-core/attribution";
import { act, render, screen } from "@testing-library/react";
import type { MapGeoJSONFeature } from "maplibre-gl";
import { afterEach, expect, it, vi } from "vitest";
import { useMapAttributionStore } from "@/integration-api/overlay/mapAttributionStore";
import { createFakeMap } from "@/test";
import { SharedMapView } from "./SharedMapView";

const fake = createFakeMap();
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

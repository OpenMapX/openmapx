import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { layerRegistrations } from "@/integration-api/map/layerStack";
import { act, createFakeMap, type FakeMap, render } from "@/test";
import { useTravelTimeStore } from "../store";

let fake: FakeMap;
const mapRef = {
  get current() {
    return fake.map;
  },
};
vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ mapRef, mapReady: true, styleVersion: 0 }),
}));
vi.mock("@openmapx/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openmapx/core")>()),
  useIsochrone: () => ({
    data: {
      mode: "walking",
      contours: [
        {
          time: 10,
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [0, 0],
                [1, 0],
                [1, 1],
                [0, 0],
              ],
            ],
          },
          contributors: [],
        },
      ],
    },
  }),
  useTransitIsochrone: () => ({ data: undefined }),
  useTransitReachability: () => ({ data: undefined }),
}));

import { TravelTimeLayer } from "../map-layer";

const SOURCE = "travel-time-source";
const ORIGIN_SOURCE = "travel-time-origin-source";
const LAYERS = [
  "travel-time-fill",
  "travel-time-outline",
  "travel-time-reach",
  "travel-time-origin-pulse",
  "travel-time-origin",
];

function features(sourceId: string) {
  return (fake.state.sources.get(sourceId)?.data as GeoJSON.FeatureCollection | undefined)
    ?.features;
}

beforeEach(() => {
  fake = createFakeMap();
  Object.assign(fake.map, { doubleClickZoom: { enable: vi.fn(), disable: vi.fn() } });
  useTravelTimeStore.setState({ isActive: true, mode: "walking", origin: [0.5, 0.5] });
});
afterEach(() => {
  act(() => useTravelTimeStore.setState({ isActive: false, origin: null }));
});

it("keeps contours and the origin across a style rebuild, then removes everything on deactivate", () => {
  const view = render(<TravelTimeLayer />);
  expect(features(SOURCE)).toHaveLength(1);
  expect(features(ORIGIN_SOURCE)).toHaveLength(1);

  act(() => {
    fake.map.setStyle({ version: 8, sources: {}, layers: [] });
  });
  for (const id of LAYERS) expect(fake.map.getLayer(id)).toBeDefined();
  expect(features(SOURCE)).toHaveLength(1);
  expect(features(ORIGIN_SOURCE)?.[0]?.geometry).toEqual({
    type: "Point",
    coordinates: [0.5, 0.5],
  });

  act(() => useTravelTimeStore.setState({ isActive: false }));
  for (const id of LAYERS) expect(fake.map.getLayer(id)).toBeUndefined();
  expect(fake.map.getSource(SOURCE)).toBeUndefined();
  expect(fake.map.getSource(ORIGIN_SOURCE)).toBeUndefined();
  expect(layerRegistrations().filter((entry) => entry.id.startsWith("travel-time-"))).toEqual([]);
  view.unmount();
});

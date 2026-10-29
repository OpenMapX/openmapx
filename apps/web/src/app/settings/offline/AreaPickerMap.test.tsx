// @vitest-environment jsdom

import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { act, createFakeMap } from "@/test";

const pendingMaps: ReturnType<typeof createFakeMap>[] = [];

vi.mock("@/integration-api/runtime/EnvProvider", () => {
  const env = { styleProvider: "openmapx" };
  return { useEnv: () => env };
});

vi.mock("@/lib/map", () => ({
  baseMapVectorCredits: () => [],
  loadMaptilerStyle: vi.fn().mockResolvedValue({}),
  loadOpenMapXStyle: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/components/map/MapCredits", () => ({
  MapCredits: () => null,
}));

vi.mock("maplibre-gl", () => {
  let workerUrl = "";
  class FakeMap {
    static instances: FakeMap[] = [];
    static workerUrlsAtConstruction: string[] = [];

    remove = vi.fn();
    fitBounds = vi.fn();
    isStyleLoaded = () => false;
    once = vi.fn();
    touchZoomRotate = { disableRotation: vi.fn() };
    keyboard = { disableRotation: vi.fn() };

    constructor() {
      const pending = createFakeMap({
        styleLoaded: false,
        zoom: 5,
        bounds: { west: 1, south: 2, east: 3, north: 4 },
      });
      pendingMaps.push(pending);
      vi.spyOn(pending.map, "fitBounds");
      Object.assign(this, pending.map, { trigger: pending.emit });
      FakeMap.instances.push(this);
      FakeMap.workerUrlsAtConstruction.push(workerUrl);
    }
  }

  return {
    getVersion: () => "6.1.0",
    getWorkerUrl: () => workerUrl,
    Map: FakeMap,
    setWorkerUrl: (url: string) => {
      workerUrl = url;
    },
  };
});

import * as maplibregl from "maplibre-gl";
import { AreaPickerMap } from "./AreaPickerMap";

const fakeMapClass = maplibregl.Map as unknown as {
  instances: Array<{
    remove: ReturnType<typeof vi.fn>;
    fitBounds: ReturnType<typeof vi.fn>;
    trigger: (event: string) => void;
  }>;
  workerUrlsAtConstruction: string[];
};

afterEach(() => {
  pendingMaps.length = 0;
  fakeMapClass.instances.length = 0;
  fakeMapClass.workerUrlsAtConstruction.length = 0;
});

describe("AreaPickerMap", () => {
  it("keeps the map mounted when the change callback identity changes", async () => {
    const firstOnChange = vi.fn();
    const latestOnChange = vi.fn();
    const { rerender } = render(
      <AreaPickerMap initialCenter={[10.45, 51.16]} initialZoom={4} onChange={firstOnChange} />,
    );

    await waitFor(() => expect(fakeMapClass.instances).toHaveLength(1));
    expect(fakeMapClass.workerUrlsAtConstruction).toEqual([
      "/runtime/maplibre-gl/6.1.0/maplibre-gl-worker.mjs",
    ]);

    // Initial bounds are emitted immediately, independently of tile loading.
    firstOnChange.mockClear();
    rerender(
      <AreaPickerMap initialCenter={[10.45, 51.16]} initialZoom={4} onChange={latestOnChange} />,
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fakeMapClass.instances).toHaveLength(1);
    expect(fakeMapClass.instances[0]?.remove).not.toHaveBeenCalled();

    fakeMapClass.instances[0]?.trigger("moveend");
    expect(firstOnChange).not.toHaveBeenCalled();
    expect(latestOnChange).toHaveBeenCalledWith({ west: 1, south: 2, east: 3, north: 4 }, 5);
  });
});

it("frames initial and changed download areas without waiting for map tiles", async () => {
  const onChange = vi.fn();
  const initial = { west: 6, south: 50, east: 7, north: 51 };
  const view = render(
    <AreaPickerMap
      initialCenter={[6.5, 50.5]}
      initialZoom={8}
      onChange={onChange}
      fitBbox={initial}
    />,
  );
  await waitFor(() => expect(fakeMapClass.instances).toHaveLength(1));
  const map = fakeMapClass.instances[0];
  expect(map.fitBounds).toHaveBeenCalledWith(
    [
      [6, 50],
      [7, 51],
    ],
    { padding: 24, duration: 600 },
  );
  view.rerender(
    <AreaPickerMap
      initialCenter={[6.5, 50.5]}
      initialZoom={8}
      onChange={onChange}
      fitBbox={{ west: 8, south: 52, east: 9, north: 53 }}
    />,
  );
  expect(map.fitBounds).toHaveBeenLastCalledWith(
    [
      [8, 52],
      [9, 53],
    ],
    { padding: 24, duration: 600 },
  );
  view.unmount();
});

it("installs and restores a selected boundary while tiles remain pending", async () => {
  const boundary = {
    type: "Polygon" as const,
    coordinates: [
      [
        [6, 50],
        [7, 50],
        [7, 51],
        [6, 50],
      ],
    ],
  };
  const view = render(
    <AreaPickerMap
      initialCenter={[6, 50]}
      initialZoom={8}
      onChange={vi.fn()}
      boundary={boundary}
    />,
  );
  await waitFor(() => expect(pendingMaps).toHaveLength(1));
  const pending = pendingMaps[0];
  const data = () =>
    pending.state.sources.get("picker-boundary-source")?.data as
      | GeoJSON.FeatureCollection
      | undefined;
  expect(data()?.features[0].geometry).toEqual(boundary);
  act(() => pending.map.setStyle({} as never));
  expect(data()?.features[0].geometry).toEqual(boundary);
  view.unmount();
  expect(pending.state.handlers.get("styledata")?.size ?? 0).toBe(0);
});

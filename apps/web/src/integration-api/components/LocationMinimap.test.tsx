// @vitest-environment jsdom

import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testState = (vi as unknown as { hoisted<T>(factory: () => T): T }).hoisted(() => ({
  env: {
    apiUrl: "",
    mapStyleUrl: "",
    tilesUrl: "",
    styleProvider: "openmapx" as "openmapx" | "maptiler",
    trafficTileUrlTemplate: "",
    cyclOsmTileUrlTemplate: "",
    terrainTileUrlTemplate: "",
    martinBaseUrl: "",
  },
  scheme: { mode: "light", systemMode: "light" },
  loadMaptilerStyle: vi.fn(),
  loadOpenMapXStyle: vi.fn(),
}));

vi.mock("@mui/material/styles", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@mui/material/styles")>()),
  useColorScheme: () => testState.scheme,
}));

vi.mock("@/integration-api/runtime/EnvProvider", () => ({
  useEnv: () => testState.env,
}));

vi.mock("@/lib/map", () => ({
  baseMapCreditsHtml: () => [],
  loadMaptilerStyle: testState.loadMaptilerStyle,
  loadOpenMapXStyle: testState.loadOpenMapXStyle,
}));

vi.mock("@/components/map/MapCredits", () => ({ MapCredits: () => null }));

vi.mock("maplibre-gl", () => {
  let workerUrl = "";
  const workerUrlsAtConstruction: string[] = [];
  const maps: FakeMap[] = [];
  const markers: FakeMarker[] = [];
  class FakeMap {
    flyTo = vi.fn();
    remove = vi.fn();
    options: Record<string, unknown>;

    constructor(options: Record<string, unknown>) {
      this.options = options;
      workerUrlsAtConstruction.push(workerUrl);
      maps.push(this);
    }
  }
  class FakeMarker {
    addTo = vi.fn(() => this);
    setLngLat = vi.fn(() => this);

    constructor() {
      markers.push(this);
    }
  }
  return {
    __test: { workerUrlsAtConstruction, maps, markers },
    getVersion: () => "6.1.0",
    getWorkerUrl: () => workerUrl,
    Map: FakeMap,
    Marker: FakeMarker,
    setWorkerUrl: (url: string) => {
      workerUrl = url;
    },
  };
});

import * as maplibregl from "maplibre-gl";
import { LocationMinimap } from "./LocationMinimap";

const maplibreTest = (
  maplibregl as unknown as {
    __test: {
      workerUrlsAtConstruction: string[];
      maps: Array<{
        options: Record<string, unknown>;
        flyTo: ReturnType<typeof vi.fn>;
        remove: ReturnType<typeof vi.fn>;
      }>;
      markers: Array<{ setLngLat: ReturnType<typeof vi.fn> }>;
    };
  }
).__test;

beforeEach(() => {
  testState.env.styleProvider = "openmapx";
  testState.scheme.mode = "light";
  testState.scheme.systemMode = "light";
  testState.loadMaptilerStyle.mockReset();
  testState.loadOpenMapXStyle.mockReset();
  testState.loadMaptilerStyle.mockResolvedValue({ name: "maptiler" });
  testState.loadOpenMapXStyle.mockResolvedValue({ name: "openmapx-light" });
});

afterEach(() => {
  maplibreTest.workerUrlsAtConstruction.length = 0;
  maplibreTest.maps.length = 0;
  maplibreTest.markers.length = 0;
});

describe("LocationMinimap", () => {
  it("configures the versioned worker before constructing its map", async () => {
    render(<LocationMinimap lng={6.084959} lat={50.780558} />);

    await waitFor(() => expect(maplibreTest.workerUrlsAtConstruction).toHaveLength(1));
    expect(maplibreTest.workerUrlsAtConstruction).toEqual([
      "/runtime/maplibre-gl/6.1.0/maplibre-gl-worker.mjs",
    ]);
  });

  it("constructs with the latest camera when props change during style loading", async () => {
    let resolveStyle: (style: Record<string, unknown>) => void = () => {};
    testState.loadOpenMapXStyle.mockImplementation(
      () => new Promise((resolve) => (resolveStyle = resolve)),
    );
    const view = render(<LocationMinimap lng={1} lat={2} zoom={10} />);

    view.rerender(<LocationMinimap lng={3} lat={4} zoom={12} />);
    resolveStyle({ name: "delayed" });

    await waitFor(() => expect(maplibreTest.maps).toHaveLength(1));
    expect(maplibreTest.maps[0]?.options).toMatchObject({ center: [3, 4], zoom: 12 });
    expect(maplibreTest.markers[0]?.setLngLat).toHaveBeenCalledWith([3, 4]);
  });

  it("moves the existing map when coordinates or zoom change", async () => {
    const view = render(<LocationMinimap lng={1} lat={2} zoom={10} />);
    await waitFor(() => expect(maplibreTest.maps).toHaveLength(1));

    view.rerender(<LocationMinimap lng={3} lat={4} zoom={12} />);

    expect(maplibreTest.markers[0]?.setLngLat).toHaveBeenLastCalledWith([3, 4]);
    expect(maplibreTest.maps[0]?.flyTo).toHaveBeenLastCalledWith({
      center: [3, 4],
      zoom: 12,
      duration: 300,
    });
    expect(maplibreTest.maps).toHaveLength(1);
  });

  it("recreates the minimap when the resolved theme or provider changes", async () => {
    const view = render(<LocationMinimap lng={1} lat={2} />);
    await waitFor(() => expect(maplibreTest.maps).toHaveLength(1));

    testState.scheme.mode = "dark";
    view.rerender(<LocationMinimap lng={1} lat={2} />);
    await waitFor(() => expect(maplibreTest.maps).toHaveLength(2));
    expect(maplibreTest.maps[0]?.remove).toHaveBeenCalledTimes(1);
    expect(testState.loadOpenMapXStyle).toHaveBeenLastCalledWith(testState.env, "dark");

    testState.env = { ...testState.env, styleProvider: "maptiler" };
    view.rerender(<LocationMinimap lng={1} lat={2} />);
    await waitFor(() => expect(maplibreTest.maps).toHaveLength(3));
    expect(maplibreTest.maps[1]?.remove).toHaveBeenCalledTimes(1);
    expect(testState.loadMaptilerStyle).toHaveBeenCalledWith("streets-v2-dark", testState.env);
  });
});

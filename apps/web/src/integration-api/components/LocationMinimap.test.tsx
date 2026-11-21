// @vitest-environment jsdom

import { useSettingsStore } from "@openmapx/core";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testState = (vi as unknown as { hoisted<T>(factory: () => T): T }).hoisted(() => ({
  env: {
    apiUrl: "",
    mapStyleUrl: "",
    tilesUrl: "",
    styleProvider: "openmapx" as "openmapx" | "maptiler",
    trafficTileUrlTemplate: "",
    cyclOsmTileUrlTemplate: "",
    terrainDemTilejsonUrl: "",
    terrainDemTileUrlTemplate: "",
    terrainDemEncoding: "mapbox",
    terrainContourMode: "vector",
    terrainContourTilejsonUrl: "",
    terrainAttributionName: "© MapTiler",
    terrainAttributionUrl: "https://www.maptiler.com/copyright/",
    martinBaseUrl: "",
    streetDetailTilesUrl: "",
  },
  scheme: { mode: "light", systemMode: "light" },
  loadMaptilerStyle: vi.fn(),
  loadOpenMapXStyle: vi.fn(),
}));

vi.mock("next-intl", () => ({ useLocale: () => "en" }));

vi.mock("@mui/material/styles", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@mui/material/styles")>()),
  useColorScheme: () => testState.scheme,
}));

vi.mock("@/integration-api/runtime/EnvProvider", () => ({
  useEnv: () => testState.env,
}));

vi.mock("@/lib/map", async (original) => ({
  ...(await original<typeof import("@/lib/map")>()),
  loadMaptilerStyle: testState.loadMaptilerStyle,
  loadOpenMapXStyle: testState.loadOpenMapXStyle,
}));

vi.mock("@/components/map/MapCredits", () => ({
  MapCredits: ({ attributions }: { attributions: Array<{ name: string }> }) => (
    <div data-testid="map-credits">{attributions.map((credit) => credit.name).join(" | ")}</div>
  ),
}));

vi.mock("maplibre-gl", () => {
  let workerUrl = "";
  const workerUrlsAtConstruction: string[] = [];
  const maps: FakeMap[] = [];
  const markers: FakeMarker[] = [];
  class FakeMap {
    flyTo = vi.fn();
    remove = vi.fn();
    on = vi.fn();
    off = vi.fn();
    layout = new Map<string, Record<string, unknown>>([
      ["place-city-capital", { "text-field": "{name:latin}\n{name:nonlatin}" }],
    ]);
    getStyle = vi.fn(() => ({ layers: [{ id: "place-city-capital", type: "symbol" }] }));
    getLayersOrder = vi.fn(() => ["place-city-capital"]);
    getLayer = vi.fn((id: string) =>
      id === "place-city-capital"
        ? { id: "place-city-capital", type: "symbol", source: "openmaptiles" }
        : undefined,
    );
    getLayoutProperty = vi.fn((id: string, prop: string) => this.layout.get(id)?.[prop]);
    setLayoutProperty = vi.fn((id: string, prop: string, value: unknown) => {
      const current = this.layout.get(id) ?? {};
      this.layout.set(id, { ...current, [prop]: value });
    });
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
        on: ReturnType<typeof vi.fn>;
        off: ReturnType<typeof vi.fn>;
        getLayoutProperty: (id: string, prop: string) => unknown;
      }>;
      markers: Array<{ setLngLat: ReturnType<typeof vi.fn> }>;
    };
  }
).__test;

beforeEach(() => {
  testState.env.styleProvider = "openmapx";
  testState.env.tilesUrl = "";
  testState.scheme.mode = "light";
  testState.scheme.systemMode = "light";
  testState.loadMaptilerStyle.mockReset();
  testState.loadOpenMapXStyle.mockReset();
  testState.loadMaptilerStyle.mockResolvedValue({
    name: "maptiler",
    sources: { openmaptiles: { type: "vector" } },
    layers: [],
  });
  testState.loadOpenMapXStyle.mockResolvedValue({
    name: "openmapx-light",
    sources: { openmaptiles: { type: "vector" } },
    layers: [],
  });
});

afterEach(() => {
  maplibreTest.workerUrlsAtConstruction.length = 0;
  maplibreTest.maps.length = 0;
  maplibreTest.markers.length = 0;
});

describe("LocationMinimap", () => {
  it("constructs with the latest camera when props change during style loading", async () => {
    let resolveStyle: (style: Record<string, unknown>) => void = () => {};
    testState.loadOpenMapXStyle.mockImplementation(
      () => new Promise<Record<string, unknown>>((resolve) => (resolveStyle = resolve)),
    );
    const view = render(<LocationMinimap lng={1} lat={2} zoom={10} />);

    view.rerender(<LocationMinimap lng={3} lat={4} zoom={12} />);
    resolveStyle({ name: "delayed", sources: {}, layers: [] });

    await waitFor(() => expect(maplibreTest.maps).toHaveLength(1));
    expect(maplibreTest.maps[0]?.options).toMatchObject({ center: [3, 4], zoom: 12 });
    expect(maplibreTest.markers[0]?.setLngLat).toHaveBeenCalledWith([3, 4]);
  });

  it("moves the existing map when coordinates or zoom change", async () => {
    const view = render(<LocationMinimap lng={1} lat={2} zoom={10} />);
    await waitFor(() => expect(maplibreTest.maps).toHaveLength(1));
    expect(maplibreTest.workerUrlsAtConstruction).toEqual([
      "/runtime/maplibre-gl/6.1.0/maplibre-gl-worker.mjs",
    ]);

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

  it("re-localizes an already-loaded minimap on showLocalScript toggle and removes style listeners on unmount", async () => {
    useSettingsStore.setState({ showLocalScript: true });
    const view = render(<LocationMinimap lng={139.76} lat={35.68} />);
    await waitFor(() => expect(maplibreTest.maps).toHaveLength(1));
    const map = maplibreTest.maps[0];
    expect(map).toBeDefined();

    const initialField = map?.getLayoutProperty("place-city-capital", "text-field") as unknown[];
    expect(initialField[0]).toBe("let");

    act(() => {
      useSettingsStore.setState({ showLocalScript: false });
    });
    expect(map?.getLayoutProperty("place-city-capital", "text-field")).toEqual([
      "coalesce",
      ["get", "name:en"],
      ["get", "name:latin"],
      ["get", "name_en"],
      ["get", "name"],
    ]);
    expect(maplibreTest.maps).toHaveLength(1);

    view.unmount();
    expect(map?.off).toHaveBeenCalledWith("styledata", expect.any(Function));
    expect(map?.off).toHaveBeenCalledWith("styledataloading", expect.any(Function));
    useSettingsStore.setState({ showLocalScript: true });
  });
});

describe("installed minimap supplier credits", () => {
  it("lets the gallery own credits only after a map is actually constructed", async () => {
    let resolveStyle: (style: Record<string, unknown>) => void = () => {};
    testState.loadOpenMapXStyle.mockImplementation(
      () => new Promise<Record<string, unknown>>((resolve) => (resolveStyle = resolve)),
    );
    const onCreditsChange = vi.fn();
    render(<LocationMinimap lng={1} lat={2} onCreditsChange={onCreditsChange} />);
    expect(onCreditsChange).not.toHaveBeenCalled();
    expect(screen.queryByTestId("map-credits")).toBeNull();
    resolveStyle({ sources: { openmaptiles: { type: "vector" } }, layers: [] });
    await waitFor(() => expect(onCreditsChange).toHaveBeenCalled());
    const loadedCredits = onCreditsChange.mock.calls.at(-1)?.[0] as readonly { sourceId: string }[];
    expect(loadedCredits.map((credit) => credit.sourceId)).toEqual([
      "openmaptiles",
      "openstreetmap",
      "maptiler",
    ]);
    expect(screen.queryByTestId("map-credits")).toBeNull();
  });

  it("keeps default credits tied to the loaded provider when configuration mutates in flight", async () => {
    let resolveStyle: (style: Record<string, unknown>) => void = () => {};
    testState.loadOpenMapXStyle.mockImplementation(
      () => new Promise<Record<string, unknown>>((resolve) => (resolveStyle = resolve)),
    );
    render(<LocationMinimap lng={1} lat={2} />);
    expect(screen.queryByText(/MapTiler/)).toBeNull();
    testState.env.styleProvider = "maptiler";
    testState.env.tilesUrl = "/changed-after-request";
    resolveStyle({ sources: { openmaptiles: { type: "vector" } }, layers: [] });
    await waitFor(() => expect(screen.getByTestId("map-credits")).toHaveTextContent("MapTiler"));
    expect(screen.getByTestId("map-credits")).toHaveTextContent("OpenStreetMap");
  });

  it("does not publish suppliers for a failed style request", async () => {
    testState.loadOpenMapXStyle.mockRejectedValue(new Error("style unavailable"));
    const onCreditsChange = vi.fn();
    render(<LocationMinimap lng={1} lat={2} onCreditsChange={onCreditsChange} />);
    await waitFor(() => expect(testState.loadOpenMapXStyle).toHaveBeenCalled());
    expect(maplibreTest.maps).toHaveLength(0);
    expect(onCreditsChange).not.toHaveBeenCalled();
  });
});

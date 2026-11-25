// @vitest-environment jsdom

import { useMeasurementStore } from "@integrations/overlay-tool-measurement/store";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureMapClickOwnership,
  getMapClickOwner,
} from "@/integration-api/map/mapClickOwnership";
import { nth } from "@/test";

const originalConsoleError = console.error;

vi.mock("@mui/material/styles", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@mui/material/styles")>()),
  useColorScheme: () => ({ mode: "light", systemMode: "light" }),
}));

vi.mock("next-intl", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next-intl")>()),
  useLocale: () => "en",
  useTranslations: (namespace: string) => (key: string) =>
    (
      ({
        "map.loading": "Loading map…",
        "map.loadError": "The map could not be loaded.",
        "common.retry": "Retry",
      }) as Record<string, string>
    )[`${namespace}.${key}`],
}));

vi.mock("@/integration-api/runtime/EnvProvider", () => {
  const env = {
    apiUrl: "",
    mapStyleUrl: "",
    styleProvider: "openmapx",
    tilesUrl: "",
  };
  return { useEnv: () => env };
});

vi.mock("@/integration-api/map/MapContext", () => {
  const mapRef = { current: null as unknown };
  const value = {
    mapRef,
    mapReady: false,
    notifyMapReady: vi.fn(),
    notifyStyleReload: vi.fn(),
  };
  return { __test: value, useMap: () => value };
});

vi.mock("@/lib/map", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/map")>();
  const style = {
    version: 8,
    sources: { openmaptiles: { type: "vector", tiles: [] } },
    layers: [] as Array<{
      id: string;
      type: string;
      source?: string;
      "source-layer"?: string;
      layout?: Record<string, unknown>;
    }>,
  };
  let stylePromise = Promise.resolve(style);
  const test = {
    deferStyle() {
      let resolve!: () => void;
      stylePromise = new Promise((done) => {
        resolve = () => done(style);
      });
      return resolve;
    },
    failStyleOnce(error: Error) {
      stylePromise = Promise.reject(error);
      return () => {
        stylePromise = Promise.resolve(style);
      };
    },
    reset() {
      style.layers = [];
      stylePromise = Promise.resolve(style);
    },
    setStyleLayers(layers: typeof style.layers) {
      style.layers = layers;
      stylePromise = Promise.resolve(style);
    },
  };
  return {
    ...actual,
    __test: test,
    loadMaptilerStyle: vi.fn(),
    loadOpenMapXStyle: vi.fn(() => stylePromise),
  };
});

vi.mock("@/lib/offlineAreas", () => ({
  ensureOfflinePackageRuntime: vi.fn().mockResolvedValue(undefined),
  OFFLINE_PACKAGE_CHANGED_EVENT: "openmapx:offline-package-changed",
  registerOfflinePmtilesProtocol: vi.fn(),
  selectOnlineFirstOpenMapXStyle: vi.fn(async (style) => ({ offline: false, style })),
  setOfflinePackageActive: vi.fn(),
}));

vi.mock("maplibre-gl", () => {
  type Listener = (event?: unknown) => void;
  const instances: FakeMap[] = [];
  const options: Array<{
    center: [number, number];
    container: HTMLElement;
    style: { layers: Array<{ id: string }> };
    zoom: number;
  }> = [];
  const workerUrlsAtConstruction: string[] = [];
  let workerUrl = "";
  let setupError: Error | undefined;
  let setupErrorOnCall = 1;
  let onCallCount = 0;
  let initialStyleLoaded = true;
  let initialStyleDefinitionLoaded = true;
  class FakeMap {
    container: HTMLElement;
    jumpTo = vi.fn();
    style = { _loaded: initialStyleDefinitionLoaded };
    styleLoaded = initialStyleLoaded;
    /** Counts camera reads so a test can prove a guarded path never took one. */
    cameraReads = 0;

    constructor(mapOptions: {
      center: [number, number];
      container: HTMLElement;
      style: { layers: Array<{ id: string }> };
      zoom: number;
    }) {
      this.container = mapOptions.container;
      instances.push(this);
      options.push(mapOptions);
      workerUrlsAtConstruction.push(workerUrl);
      mapOptions.container.append(document.createElement("canvas"));
    }

    getStyle = () => (this.style._loaded ? options[instances.indexOf(this)]?.style : undefined);
    setStyle = vi.fn((input: unknown) => {
      const style = input as { layers: Array<{ id: string }> };
      nth(options, instances.indexOf(this)).style = style;
    });
    getLayersOrder = () => this.getStyle()?.layers.map((layer) => layer.id) ?? [];
    getLayer = (id: string) => this.getStyle()?.layers.find((layer) => layer.id === id);
    getLayoutProperty = (id: string, name: string) => {
      const layer = this.getLayer(id) as { layout?: Record<string, unknown> } | undefined;
      return layer?.layout?.[name];
    };
    setLayoutProperty = vi.fn((id: string, name: string, value: unknown) => {
      const layer = this.getLayer(id) as { layout?: Record<string, unknown> } | undefined;
      if (!layer) return;
      layer.layout = { ...(layer.layout ?? {}), [name]: value };
    });
    getSource = () => undefined;

    getCenter = () => {
      this.cameraReads += 1;
      return { lng: 1.5, lat: 2.5 };
    };
    getZoom = () => 12;
    getBearing = () => 33;
    getPitch = () => 44;
    isStyleLoaded = () => this.styleLoaded;
    off = vi.fn();
    on = vi.fn((_event: string, _listener: Listener) => {
      onCallCount += 1;
      if (!setupError || onCallCount !== setupErrorOnCall) return;
      const error = setupError;
      setupError = undefined;
      throw error;
    });
    once = vi.fn((_event: string, _listener: Listener) => {});
    addControl = vi.fn();
    removeControl = vi.fn();
    canvas = document.createElement("canvas");
    getCanvas = () => this.canvas;
    // Like MapLibre: tearing the map down loses its WebGL context.
    remove = vi.fn(() => {
      this.canvas.dispatchEvent(new Event("webglcontextlost"));
    });
    emitError(error: Error, data: Record<string, unknown> = {}) {
      const listener = this.on.mock.calls.find(([event]) => event === "error")?.[1];
      listener?.({ error, style: this.style, ...data });
    }
    emitStyleLoad() {
      this.style._loaded = true;
      this.styleLoaded = true;
      for (const [event, listener] of this.on.mock.calls) {
        if (event === "style.load") listener();
      }
      this.once.mock.calls.find(([event]) => event === "style.load")?.[1]();
    }
  }
  return {
    __test: {
      instances,
      options,
      workerUrlsAtConstruction,
      failSetup(error: Error, onCall = 1) {
        setupError = error;
        setupErrorOnCall = onCall;
      },
      deferInitialStyle(definitionLoaded: boolean) {
        initialStyleLoaded = false;
        initialStyleDefinitionLoaded = definitionLoaded;
      },
      loadInitialStyleOnConstruction() {
        initialStyleLoaded = true;
        initialStyleDefinitionLoaded = true;
      },
      reset() {
        instances.length = 0;
        options.length = 0;
        workerUrlsAtConstruction.length = 0;
        workerUrl = "";
        setupError = undefined;
        setupErrorOnCall = 1;
        onCallCount = 0;
        initialStyleLoaded = true;
        initialStyleDefinitionLoaded = true;
      },
    },
    getVersion: () => "6.1.0",
    getWorkerUrl: () => workerUrl,
    Map: FakeMap,
    setWorkerUrl: (url: string) => {
      workerUrl = url;
    },
  };
});

import {
  configureStorage,
  useMapStore,
  useNavigationStore,
  useSettingsStore,
} from "@openmapx/core";
import * as maplibre from "maplibre-gl";
import * as mapContext from "@/integration-api/map/MapContext";
import * as mapStyle from "@/lib/map";
import { MAP_FOOTER_OBSTRUCTION_ID } from "@/lib/mapFooterCenter";
import { publishMapObstruction } from "@/lib/mapObstructions";
import { MapCanvas } from "./MapCanvas";

const maplibreTest = (
  maplibre as unknown as {
    __test: {
      instances: Array<{
        addControl: ReturnType<typeof vi.fn>;
        cameraReads: number;
        emitError(error: Error, data?: Record<string, unknown>): void;
        emitStyleLoad(): void;
        getLayoutProperty(id: string, name: string): unknown;
        isStyleLoaded(): boolean;
        setStyle: ReturnType<typeof vi.fn>;
        jumpTo: ReturnType<typeof vi.fn>;
        on: ReturnType<typeof vi.fn>;
        removeControl: ReturnType<typeof vi.fn>;
        remove: ReturnType<typeof vi.fn>;
      }>;
      options: Array<{
        center: [number, number];
        style: { layers: Array<{ id: string }> };
        zoom: number;
      }>;
      workerUrlsAtConstruction: string[];
      failSetup(error: Error, onCall?: number): void;
      deferInitialStyle(definitionLoaded: boolean): void;
      loadInitialStyleOnConstruction(): void;
      reset(): void;
    };
  }
).__test;
const mapStyleTest = (
  mapStyle as unknown as {
    __test: {
      deferStyle(): () => void;
      failStyleOnce(error: Error): () => void;
      reset(): void;
      setStyleLayers(
        layers: Array<{
          id: string;
          type: string;
          source?: string;
          "source-layer"?: string;
          layout?: Record<string, unknown>;
        }>,
      ): void;
    };
  }
).__test;
const mapContextTest = (
  mapContext as unknown as {
    __test: {
      mapRef: { current: unknown };
      notifyMapReady: ReturnType<typeof vi.fn>;
    };
  }
).__test;

afterEach(() => {
  useMeasurementStore.getState().deactivate();
  console.error = originalConsoleError;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  useNavigationStore.getState().stopNavigation();
});

/** Render a map and hand back its registered `moveend` listener. */
async function renderWithMoveEnd() {
  maplibreTest.reset();
  mapStyleTest.reset();
  useMapStore.setState({ bearing: 0, center: [0, 20], pitch: 0, userLocation: null, zoom: 2 });
  vi.stubGlobal("navigator", { ...navigator, geolocation: undefined, permissions: undefined });

  render(<MapCanvas />);
  await waitFor(() => expect(maplibreTest.instances).toHaveLength(1));
  const map = nth(maplibreTest.instances, 0);
  const moveEnd = map.on.mock.calls.find(([event]: unknown[]) => event === "moveend")?.[1] as (
    e?: unknown,
  ) => void;
  expect(moveEnd).toBeTypeOf("function");
  return { map, moveEnd };
}

describe("MapCanvas", () => {
  it("initializes tool ownership without waiting for the sibling click-handler chunk", async () => {
    configureMapClickOwnership(() => null);
    useMeasurementStore.getState().activate();
    const view = render(<MapCanvas />);
    await waitFor(() => expect(mapContextTest.mapRef.current).not.toBeNull());
    expect(getMapClickOwner(new MouseEvent("click"))).toBe("measurement");
    view.unmount();
    useMeasurementStore.getState().deactivate();
  });
  it("removes native building extrusions while preserving flat buildings and other 3D layers", async () => {
    maplibreTest.reset();
    mapStyleTest.reset();
    mapStyleTest.setStyleLayers([
      { id: "Building", type: "fill", source: "city", "source-layer": "building" },
      { id: "Building 3D", type: "fill-extrusion", source: "city", "source-layer": "building" },
      { id: "Uppercase", type: "fill-extrusion", source: "city", "source-layer": "Building" },
      { id: "buildings-3d", type: "fill-extrusion", source: "city", "source-layer": "structures" },
      {
        id: "shipbuilding-monument",
        type: "fill-extrusion",
        source: "city",
        "source-layer": "landmark",
      },
    ]);
    vi.stubGlobal("navigator", { ...navigator, geolocation: undefined, permissions: undefined });

    render(<MapCanvas />);
    await waitFor(() => expect(maplibreTest.options).toHaveLength(1));
    expect(nth(maplibreTest.options, 0).style.layers.map((layer) => layer.id)).toEqual([
      "Building",
      "shipbuilding-monument",
    ]);
  });

  it("reports a lost WebGL context on the car surface, but not its own teardown", async () => {
    maplibreTest.reset();
    mapStyleTest.reset();
    vi.stubGlobal("navigator", { ...navigator, geolocation: undefined, permissions: undefined });
    const onSurfaceError = vi.fn();
    const { unmount } = render(<MapCanvas carSurface onSurfaceError={onSurfaceError} />);
    await waitFor(() => expect(maplibreTest.instances).toHaveLength(1));
    const map = maplibreTest.instances[0] as unknown as { canvas: HTMLCanvasElement };
    await waitFor(() => {
      map.canvas.dispatchEvent(new Event("webglcontextlost"));
      expect(onSurfaceError).toHaveBeenCalledWith("webgl-lost");
    });
    onSurfaceError.mockClear();
    unmount();
    expect(onSurfaceError).not.toHaveBeenCalled();
  });

  it("renders the base map without waiting for a granted geolocation callback", async () => {
    maplibreTest.reset();
    mapStyleTest.reset();
    useMapStore.setState({ center: [0, 20], userLocation: null, zoom: 2 });
    vi.stubGlobal("navigator", {
      ...navigator,
      geolocation: {
        getCurrentPosition: vi.fn(),
      },
      permissions: {
        query: vi.fn().mockResolvedValue({ state: "granted" }),
      },
    });

    const { container } = render(<MapCanvas />);

    await waitFor(() => expect(container.querySelector("canvas")).not.toBeNull());
    expect(maplibreTest.workerUrlsAtConstruction).toEqual([
      "/runtime/maplibre-gl/6.1.0/maplibre-gl-worker.mjs",
    ]);
  });

  it("applies a fast granted location only after the saved viewport map exists", async () => {
    maplibreTest.reset();
    const resolveStyle = mapStyleTest.deferStyle();
    useMapStore.setState({ center: [11, 22], userLocation: null, zoom: 7 });
    let positionSuccess: PositionCallback | undefined;
    vi.stubGlobal("navigator", {
      ...navigator,
      geolocation: {
        getCurrentPosition: vi.fn((...args: unknown[]) => {
          positionSuccess = args[0] as PositionCallback;
        }),
      },
      permissions: {
        query: vi.fn().mockResolvedValue({ state: "granted" }),
      },
    });

    render(<MapCanvas />);
    await waitFor(() => expect(positionSuccess).toBeDefined());
    act(() => {
      positionSuccess?.({ coords: { latitude: 52.5, longitude: 13.4 } } as GeolocationPosition);
    });

    expect(useMapStore.getState().userLocation).toBeNull();
    act(() => resolveStyle());
    await waitFor(() => expect(maplibreTest.instances).toHaveLength(1));

    expect(maplibreTest.options[0]).toMatchObject({ center: [11, 22], zoom: 7 });
    expect(useMapStore.getState().userLocation).toEqual([13.4, 52.5]);
    expect(maplibreTest.instances[0]?.jumpTo).toHaveBeenCalledWith(
      { center: [13.4, 52.5], zoom: 14 },
      { programmatic: true },
    );
  });

  describe("a location fix arriving after the view is set", () => {
    function grantSlowFix() {
      let positionSuccess: PositionCallback | undefined;
      vi.stubGlobal("navigator", {
        ...navigator,
        geolocation: {
          getCurrentPosition: vi.fn((...args: unknown[]) => {
            positionSuccess = args[0] as PositionCallback;
          }),
        },
        permissions: { query: vi.fn().mockResolvedValue({ state: "granted" }) },
      });
      return {
        arrive: () =>
          positionSuccess?.({
            coords: { latitude: 50.78, longitude: 6.08 },
          } as GeolocationPosition),
        asked: () => positionSuccess !== undefined,
      };
    }

    afterEach(() => {
      window.history.replaceState(null, "", "/");
    });

    it("keeps a linked view and only places the marker", async () => {
      maplibreTest.reset();
      window.history.replaceState(null, "", "/?map=52.52,13.405,14,0,0");
      useMapStore.setState({ center: [13.405, 52.52], userLocation: null, zoom: 14 });
      const fix = grantSlowFix();

      render(<MapCanvas />);
      await waitFor(() => expect(maplibreTest.instances).toHaveLength(1));
      await waitFor(() => expect(fix.asked()).toBe(true));
      act(() => fix.arrive());

      await waitFor(() => expect(useMapStore.getState().userLocation).toEqual([6.08, 50.78]));
      expect(maplibreTest.instances[0]?.jumpTo).not.toHaveBeenCalled();
    });

    it("keeps where the user moved the map while the fix was on its way", async () => {
      maplibreTest.reset();
      useMapStore.setState({ center: [13.405, 52.52], userLocation: null, zoom: 14 });
      const fix = grantSlowFix();

      render(<MapCanvas />);
      await waitFor(() => expect(maplibreTest.instances).toHaveLength(1));
      await waitFor(() => expect(fix.asked()).toBe(true));
      const map = nth(maplibreTest.instances, 0);
      const moveStart = map?.on.mock.calls.find(
        ([event]: unknown[]) => event === "movestart",
      )?.[1] as ((event: { originalEvent?: unknown }) => void) | undefined;
      act(() => moveStart?.({ originalEvent: new MouseEvent("mousedown") }));
      act(() => fix.arrive());

      await waitFor(() => expect(useMapStore.getState().userLocation).toEqual([6.08, 50.78]));
      expect(map?.jumpTo).not.toHaveBeenCalled();
    });
  });

  it("removes a partially constructed map when initialization setup fails", async () => {
    maplibreTest.reset();
    mapStyleTest.reset();
    useMapStore.setState({ center: [0, 20], userLocation: null, zoom: 2 });
    const error = new Error("WebGL setup failed");
    // Fail on the second event registration, after MapCanvas has published
    // the instance through MapContext.
    maplibreTest.failSetup(error, 2);
    const consoleError = vi.fn();
    console.error = consoleError;
    vi.stubGlobal("navigator", {
      ...navigator,
      geolocation: undefined,
      permissions: undefined,
    });

    render(<MapCanvas />);
    await waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith("Failed to initialize map", error),
    );

    expect(maplibreTest.instances).toHaveLength(1);
    expect(maplibreTest.instances[0]?.remove).toHaveBeenCalledTimes(1);
    expect(mapContextTest.mapRef.current).toBeNull();
    expect(mapContextTest.notifyMapReady).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("The map could not be loaded.");

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(maplibreTest.instances).toHaveLength(2));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(maplibreTest.instances[0]?.remove).toHaveBeenCalledTimes(1);
    expect(maplibreTest.instances[1]?.remove).not.toHaveBeenCalled();
    expect(mapContextTest.mapRef.current).toBe(maplibreTest.instances[1]);
    expect(mapContextTest.notifyMapReady).toHaveBeenCalledTimes(1);
  });

  it("recovers from an initial style load rejection without leaving a stale error", async () => {
    maplibreTest.reset();
    mapStyleTest.reset();
    const allowStyle = mapStyleTest.failStyleOnce(new Error("Style unavailable"));
    const consoleError = vi.fn();
    console.error = consoleError;
    vi.stubGlobal("navigator", { ...navigator, geolocation: undefined, permissions: undefined });

    render(<MapCanvas />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading map…");
    await screen.findByRole("alert");
    expect(maplibreTest.instances).toHaveLength(0);

    allowStyle();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(maplibreTest.instances).toHaveLength(1));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(mapContextTest.mapRef.current).toBe(maplibreTest.instances[0]);
    expect(mapContextTest.notifyMapReady).toHaveBeenCalledTimes(1);
  });

  it("does not construct a map when an initial style resolves after unmount", async () => {
    maplibreTest.reset();
    const resolveStyle = mapStyleTest.deferStyle();
    vi.stubGlobal("navigator", { ...navigator, geolocation: undefined, permissions: undefined });

    const { unmount } = render(<MapCanvas />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading map…");
    unmount();
    await act(async () => resolveStyle());

    expect(maplibreTest.instances).toHaveLength(0);
    expect(mapContextTest.notifyMapReady).not.toHaveBeenCalled();
    expect(mapContextTest.mapRef.current).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("offers retry when MapLibre rejects the initial style before readiness", async () => {
    maplibreTest.reset();
    mapStyleTest.reset();
    maplibreTest.deferInitialStyle(false);
    console.error = vi.fn();
    vi.stubGlobal("navigator", { ...navigator, geolocation: undefined, permissions: undefined });

    render(<MapCanvas />);
    await waitFor(() => expect(maplibreTest.instances).toHaveLength(1));
    expect(screen.getByRole("status")).toHaveTextContent("Loading map…");

    act(() => maplibreTest.instances[0]?.emitError(new Error("Invalid initial style")));
    await screen.findByRole("alert");
    expect(maplibreTest.instances[0]?.remove).toHaveBeenCalledTimes(1);
    expect(mapContextTest.mapRef.current).toBeNull();
    expect(mapContextTest.notifyMapReady).not.toHaveBeenCalled();
    act(() => maplibreTest.instances[0]?.emitStyleLoad());
    expect(mapContextTest.notifyMapReady).not.toHaveBeenCalled();

    maplibreTest.loadInitialStyleOnConstruction();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(maplibreTest.instances).toHaveLength(2));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(maplibreTest.instances[1]?.remove).not.toHaveBeenCalled();
    expect(mapContextTest.notifyMapReady).toHaveBeenCalledTimes(1);
  });

  it("keeps the initial map usable when a tile fails before style readiness", async () => {
    maplibreTest.reset();
    mapStyleTest.reset();
    maplibreTest.deferInitialStyle(true);
    console.error = vi.fn();
    vi.stubGlobal("navigator", { ...navigator, geolocation: undefined, permissions: undefined });

    render(<MapCanvas />);
    await waitFor(() => expect(maplibreTest.instances).toHaveLength(1));
    const map = nth(maplibreTest.instances, 0);
    expect(map.isStyleLoaded()).toBe(false);
    expect(mapContextTest.notifyMapReady).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("status")).toBeNull();
    act(() =>
      map?.emitError(new Error("Tile unavailable"), { sourceId: "openmaptiles", tile: {} }),
    );

    expect(screen.queryByRole("alert")).toBeNull();
    expect(map?.remove).not.toHaveBeenCalled();
    act(() => map?.emitStyleLoad());
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(mapContextTest.notifyMapReady).toHaveBeenCalledTimes(1);
  });

  it("ignores a granted location that arrives after the initial map has failed", async () => {
    maplibreTest.reset();
    mapStyleTest.reset();
    maplibreTest.deferInitialStyle(false);
    useMapStore.setState({ center: [11, 22], userLocation: null, zoom: 7 });
    console.error = vi.fn();
    let positionSuccess: PositionCallback | undefined;
    vi.stubGlobal("navigator", {
      ...navigator,
      geolocation: {
        getCurrentPosition: vi.fn((...args: unknown[]) => {
          positionSuccess = args[0] as PositionCallback;
        }),
      },
      permissions: { query: vi.fn().mockResolvedValue({ state: "granted" }) },
    });

    render(<MapCanvas />);
    await waitFor(() => expect(positionSuccess).toBeDefined());
    await waitFor(() => expect(maplibreTest.instances).toHaveLength(1));
    const failedMap = maplibreTest.instances[0];
    failedMap?.jumpTo.mockImplementation(() => {
      const moveEnd = failedMap.on.mock.calls.find(
        ([event]: unknown[]) => event === "moveend",
      )?.[1] as ((event: unknown) => void) | undefined;
      moveEnd?.({ programmatic: true });
    });

    act(() => failedMap?.emitError(new Error("Invalid initial style")));
    await screen.findByRole("alert");
    await act(async () => {
      positionSuccess?.({ coords: { latitude: 52.5, longitude: 13.4 } } as GeolocationPosition);
    });

    expect(failedMap?.jumpTo).not.toHaveBeenCalled();
    expect(useMapStore.getState()).toMatchObject({
      center: [11, 22],
      userLocation: null,
      zoom: 7,
    });

    maplibreTest.loadInitialStyleOnConstruction();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(maplibreTest.instances).toHaveLength(2));
    expect(maplibreTest.options[1]).toMatchObject({ center: [11, 22], zoom: 7 });
  });

  it("persists the viewport for a programmatic move outside navigation", async () => {
    const { moveEnd } = await renderWithMoveEnd();

    act(() => moveEnd({ programmatic: true }));

    expect(useMapStore.getState().center).toEqual([1.5, 2.5]);
  });

  it("reads no camera state for its own programmatic move while navigating", async () => {
    const { map, moveEnd } = await renderWithMoveEnd();
    useNavigationStore.setState({ status: "navigating" });
    const readsBefore = map.cameraReads;

    act(() => moveEnd({ programmatic: true }));

    expect(map.cameraReads).toBe(readsBefore);
    expect(useMapStore.getState()).toMatchObject({
      bearing: 0,
      center: [0, 20],
      pitch: 0,
      zoom: 2,
    });
  });

  it("still persists a user gesture while navigating", async () => {
    const { moveEnd } = await renderWithMoveEnd();
    useNavigationStore.setState({ status: "navigating" });

    act(() => moveEnd({}));

    expect(useMapStore.getState().center).toEqual([1.5, 2.5]);
  });

  describe("the view the map was last left on", () => {
    function useMemoryStorage(entries: Record<string, string> = {}) {
      const values = new Map(Object.entries(entries));
      configureStorage({
        getString: (key) => values.get(key) ?? null,
        setString: (key, value) => {
          values.set(key, value);
        },
        remove: (key) => {
          values.delete(key);
        },
      });
      return values;
    }
    const saved = JSON.stringify({ center: [13.405, 52.52], zoom: 15 });

    afterEach(() => {
      useMemoryStorage();
      window.history.replaceState(null, "", "/");
    });

    it("saves the camera position on every move", async () => {
      const values = useMemoryStorage();
      const { map, moveEnd } = await renderWithMoveEnd();
      const readsBefore = map.cameraReads;

      act(() => moveEnd({}));
      expect(map.cameraReads).toBe(readsBefore + 1);
      expect(useMapStore.getState()).toMatchObject({
        bearing: 33,
        center: [1.5, 2.5],
        pitch: 44,
        zoom: 12,
      });

      expect(JSON.parse(values.get("openmapx:map:last-view") ?? "null")).toEqual({
        center: [1.5, 2.5],
        zoom: 12,
      });
    });

    it("opens on the saved view and keeps it when a location fix arrives", async () => {
      maplibreTest.reset();
      useMemoryStorage({ "openmapx:map:last-view": saved });
      useMapStore.setState({ center: [0, 20], userLocation: null, zoom: 2 });
      let positionSuccess: PositionCallback | undefined;
      vi.stubGlobal("navigator", {
        ...navigator,
        geolocation: {
          getCurrentPosition: vi.fn((...args: unknown[]) => {
            positionSuccess = args[0] as PositionCallback;
          }),
        },
        permissions: { query: vi.fn().mockResolvedValue({ state: "granted" }) },
      });

      render(<MapCanvas />);
      await waitFor(() => expect(maplibreTest.instances).toHaveLength(1));
      expect(maplibreTest.options[0]).toMatchObject({ center: [13.405, 52.52], zoom: 15 });
      expect(useMapStore.getState()).toMatchObject({ center: [13.405, 52.52], zoom: 15 });

      await waitFor(() => expect(positionSuccess).toBeDefined());
      act(() => {
        positionSuccess?.({ coords: { latitude: 50.78, longitude: 6.08 } } as GeolocationPosition);
      });
      await waitFor(() => expect(useMapStore.getState().userLocation).toEqual([6.08, 50.78]));
      expect(maplibreTest.instances[0]?.jumpTo).not.toHaveBeenCalled();
    });

    it("lets a linked view win over the saved one", async () => {
      maplibreTest.reset();
      useMemoryStorage({ "openmapx:map:last-view": saved });
      window.history.replaceState(null, "", "/?map=48.137,11.575,12,0,0");
      useMapStore.setState({ center: [11.575, 48.137], userLocation: null, zoom: 12 });
      vi.stubGlobal("navigator", { ...navigator, geolocation: undefined, permissions: undefined });

      render(<MapCanvas />);
      await waitFor(() => expect(maplibreTest.instances).toHaveLength(1));
      expect(maplibreTest.options[0]).toMatchObject({ center: [11.575, 48.137], zoom: 12 });
    });

    it("neither restores nor saves a view when remembering is switched off", async () => {
      const values = useMemoryStorage({
        "openmapx:map:last-view": saved,
        "openmapx:map:remember-view": "false",
      });
      const { moveEnd } = await renderWithMoveEnd();
      expect(maplibreTest.options[0]).toMatchObject({ center: [0, 20], zoom: 2 });

      act(() => moveEnd({}));

      expect(values.get("openmapx:map:last-view")).toBe(saved);
    });
  });
});

it("keeps the installed generation during pending or rejected reloads and ignores late style completions", async () => {
  maplibreTest.reset();
  mapStyleTest.reset();
  vi.stubGlobal("navigator", { ...navigator, geolocation: undefined, permissions: undefined });
  const view = render(<MapCanvas />);
  await waitFor(() => expect(maplibreTest.instances).toHaveLength(1));
  const map = nth(maplibreTest.instances, 0);
  act(() => map.emitStyleLoad());
  const installed = nth(maplibreTest.options, 0).style;
  const first = mapStyleTest.deferStyle();
  act(() => window.dispatchEvent(new Event("offline")));
  await act(async () => {
    await Promise.resolve();
  });
  expect(map.setStyle).not.toHaveBeenCalled();
  expect(nth(maplibreTest.options, 0).style).toBe(installed);
  const second = mapStyleTest.deferStyle();
  act(() => window.dispatchEvent(new Event("online")));
  await act(async () => {
    second();
    await Promise.resolve();
  });
  await waitFor(() => expect(map.setStyle).toHaveBeenCalledTimes(1));
  const latest = nth(maplibreTest.options, 0).style;
  await act(async () => {
    first();
    await Promise.resolve();
  });
  expect(map.setStyle).toHaveBeenCalledTimes(1);
  expect(nth(maplibreTest.options, 0).style).toBe(latest);
  console.error = vi.fn();
  const reset = mapStyleTest.failStyleOnce(new Error("reload failed"));
  await act(async () => {
    window.dispatchEvent(new Event("offline"));
    await Promise.resolve();
  });
  expect(map.setStyle).toHaveBeenCalledTimes(1);
  expect(nth(maplibreTest.options, 0).style).toBe(latest);
  reset();
  view.unmount();
});

it("applies bilingual labels on the main map, reacts to showLocalScript, and disables them on the car surface", async () => {
  maplibreTest.reset();
  mapStyleTest.reset();
  useSettingsStore.setState({ showLocalScript: true });
  const mapContextTest = (
    mapContext as unknown as { __test: { mapReady: boolean; mapRef: { current: unknown } } }
  ).__test;
  mapContextTest.mapReady = false;
  mapStyleTest.setStyleLayers([
    {
      id: "place-city-capital",
      type: "symbol",
      source: "openmaptiles",
      layout: { "text-field": "{name:latin}\n{name:nonlatin}" },
    },
  ]);
  vi.stubGlobal("navigator", { ...navigator, geolocation: undefined, permissions: undefined });

  const view = render(<MapCanvas />);
  await waitFor(() => expect(maplibreTest.instances).toHaveLength(1));
  const map = nth(maplibreTest.instances, 0);
  // Mirror MapContext flipping mapReady once the map finishes initializing.
  mapContextTest.mapReady = true;
  view.rerender(<MapCanvas />);
  const bilingualField = map.getLayoutProperty("place-city-capital", "text-field") as unknown[];
  expect(Array.isArray(bilingualField) && bilingualField[0] === "let").toBe(true);

  act(() => {
    useSettingsStore.setState({ showLocalScript: false });
  });
  expect(map.getLayoutProperty("place-city-capital", "text-field")).toEqual([
    "coalesce",
    ["get", "name:en"],
    ["get", "name:latin"],
    ["get", "name_en"],
    ["get", "name"],
  ]);

  // Re-enable showLocalScript, then mount the car surface: labels must stay single-language.
  act(() => {
    useSettingsStore.setState({ showLocalScript: true });
  });
  expect((map.getLayoutProperty("place-city-capital", "text-field") as unknown[])[0]).toBe("let");

  view.unmount();
  mapContextTest.mapReady = false;
  mapStyleTest.setStyleLayers([
    {
      id: "place-city-capital",
      type: "symbol",
      source: "openmaptiles",
      layout: { "text-field": "{name:latin}\n{name:nonlatin}" },
    },
  ]);

  const carView = render(<MapCanvas carSurface />);
  await waitFor(() => expect(maplibreTest.instances).toHaveLength(2));
  const carMap = nth(maplibreTest.instances, 1);
  mapContextTest.mapReady = true;
  carView.rerender(<MapCanvas carSurface />);
  expect(carMap.getLayoutProperty("place-city-capital", "text-field")).toEqual([
    "coalesce",
    ["get", "name:en"],
    ["get", "name:latin"],
    ["get", "name_en"],
    ["get", "name"],
  ]);

  carView.unmount();
  mapContextTest.mapReady = false;
  useSettingsStore.setState({ showLocalScript: true });
});

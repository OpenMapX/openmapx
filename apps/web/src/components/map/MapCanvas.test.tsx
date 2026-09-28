// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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

vi.mock("@/lib/map", () => {
  const style = {
    version: 8,
    sources: { openmaptiles: { type: "vector", tiles: [] } },
    layers: [] as Array<{ id: string; type: string; source?: string; "source-layer"?: string }>,
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
  const instances: FakeMap[] = [];
  const scales: FakeScaleControl[] = [];
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
  class FakeScaleControl {
    setUnit = vi.fn();
    constructor(readonly options: { maxWidth?: number; unit?: string }) {
      scales.push(this);
    }
  }
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

    getCenter = () => {
      this.cameraReads += 1;
      return { lng: 1.5, lat: 2.5 };
    };
    getZoom = () => 12;
    getBearing = () => 33;
    getPitch = () => 44;
    isStyleLoaded = () => this.styleLoaded;
    off = vi.fn();
    on = vi.fn(() => {
      onCallCount += 1;
      if (!setupError || onCallCount !== setupErrorOnCall) return;
      const error = setupError;
      setupError = undefined;
      throw error;
    });
    once = vi.fn();
    addControl = vi.fn(() => {
      const corner = document.createElement("div");
      corner.className = "maplibregl-ctrl-bottom-left";
      const scale = document.createElement("div");
      scale.className = "maplibregl-ctrl maplibregl-ctrl-scale";
      corner.append(scale);
      this.container.append(corner);
    });
    removeControl = vi.fn(() => {
      this.container.querySelector(".maplibregl-ctrl-bottom-left")?.remove();
    });
    remove = vi.fn();
    emitError(error: Error, data: Record<string, unknown> = {}) {
      const listener = this.on.mock.calls.find(([event]: unknown[]) => event === "error")?.[1] as
        | ((event: unknown) => void)
        | undefined;
      listener?.({ error, style: this.style, ...data });
    }
    emitStyleLoad() {
      this.style._loaded = true;
      this.styleLoaded = true;
      for (const [event, listener] of this.on.mock.calls) {
        if (event === "style.load") (listener as () => void)();
      }
      const listener = this.once.mock.calls.find(
        ([event]: unknown[]) => event === "style.load",
      )?.[1] as (() => void) | undefined;
      listener?.();
    }
  }
  return {
    __test: {
      instances,
      scales,
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
        scales.length = 0;
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
    ScaleControl: FakeScaleControl,
    setWorkerUrl: (url: string) => {
      workerUrl = url;
    },
  };
});

import { useMapStore, useNavigationStore, useSettingsStore } from "@openmapx/core";
import * as maplibre from "maplibre-gl";
import * as mapContext from "@/integration-api/map/MapContext";
import * as mapStyle from "@/lib/map";
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
        jumpTo: ReturnType<typeof vi.fn>;
        on: ReturnType<typeof vi.fn>;
        removeControl: ReturnType<typeof vi.fn>;
        remove: ReturnType<typeof vi.fn>;
      }>;
      scales: Array<{
        options: { maxWidth?: number; unit?: string };
        setUnit: ReturnType<typeof vi.fn>;
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
        layers: Array<{ id: string; type: string; source?: string; "source-layer"?: string }>,
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
  const map = maplibreTest.instances[0];
  const moveEnd = map.on.mock.calls.find(([event]: unknown[]) => event === "moveend")?.[1] as (
    e?: unknown,
  ) => void;
  expect(moveEnd).toBeTypeOf("function");
  return { map, moveEnd };
}

describe("MapCanvas", () => {
  it("removes native building extrusions while preserving flat buildings and other 3D layers", async () => {
    maplibreTest.reset();
    mapStyleTest.reset();
    mapStyleTest.setStyleLayers([
      { id: "Building", type: "fill", source: "city", "source-layer": "building" },
      { id: "Building 3D", type: "fill-extrusion", source: "city", "source-layer": "building" },
      { id: "Other 3D", type: "fill-extrusion", source: "city", "source-layer": "landmark" },
    ]);
    vi.stubGlobal("navigator", { ...navigator, geolocation: undefined, permissions: undefined });

    render(<MapCanvas />);
    await waitFor(() => expect(maplibreTest.options).toHaveLength(1));
    expect(maplibreTest.options[0].style.layers.map((layer) => layer.id)).toEqual([
      "Building",
      "Other 3D",
    ]);
  });

  it("keeps one scale per map through unit and style changes, then removes it", async () => {
    maplibreTest.reset();
    mapStyleTest.reset();
    useSettingsStore.setState({ units: "metric" });
    vi.stubGlobal("navigator", { ...navigator, geolocation: undefined, permissions: undefined });

    const { unmount } = render(<MapCanvas />);
    await waitFor(() => expect(maplibreTest.instances).toHaveLength(1));
    const map = maplibreTest.instances[0];
    const scale = maplibreTest.scales[0];
    expect(maplibreTest.scales).toHaveLength(1);
    expect(scale?.options).toMatchObject({ unit: "metric" });
    expect(map?.addControl).toHaveBeenCalledWith(scale, "bottom-left");

    act(() => useSettingsStore.setState({ units: "imperial" }));
    expect(maplibreTest.instances).toHaveLength(1);
    expect(scale?.setUnit).toHaveBeenCalledWith("imperial");
    act(() => map?.emitStyleLoad());
    expect(map?.addControl).toHaveBeenCalledTimes(1);
    expect(maplibreTest.scales).toHaveLength(1);

    unmount();
    expect(map?.removeControl).toHaveBeenCalledWith(scale);
    expect(map?.remove).toHaveBeenCalledTimes(1);
    useSettingsStore.setState({ units: "metric" });
  });

  it("keeps the scale at the map corner when desktop panels open", async () => {
    maplibreTest.reset();
    mapStyleTest.reset();
    const previousWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 900 });
    vi.stubGlobal("navigator", { ...navigator, geolocation: undefined, permissions: undefined });
    const view = render(<MapCanvas />);
    try {
      await waitFor(() => expect(maplibreTest.instances).toHaveLength(1));
      const scale = view.container.querySelector<HTMLElement>(".maplibregl-ctrl-scale");
      expect(scale).not.toBeNull();
      act(() => publishMapObstruction("scale-test-left", "left", 800));
      expect(getComputedStyle(scale as HTMLElement).marginLeft).toBe("12px");
      expect(getComputedStyle(scale as HTMLElement).display).toBe("block");
      act(() => publishMapObstruction("scale-test-right", "right", 30));
      expect(getComputedStyle(scale as HTMLElement).marginLeft).toBe("12px");
      expect(getComputedStyle(scale as HTMLElement).display).toBe("block");
    } finally {
      view.unmount();
      act(() => publishMapObstruction("scale-test-left", "left", null));
      act(() => publishMapObstruction("scale-test-right", "right", null));
      Object.defineProperty(window, "innerWidth", { configurable: true, value: previousWidth });
    }
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
    expect(maplibreTest.instances[0]?.removeControl).toHaveBeenCalledWith(maplibreTest.scales[0]);
    expect(mapContextTest.mapRef.current).toBeNull();
    expect(mapContextTest.notifyMapReady).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("The map could not be loaded.");

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(maplibreTest.instances).toHaveLength(2));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(maplibreTest.instances[0]?.remove).toHaveBeenCalledTimes(1);
    expect(maplibreTest.instances[0]?.removeControl).toHaveBeenCalledWith(maplibreTest.scales[0]);
    expect(maplibreTest.instances[1]?.remove).not.toHaveBeenCalled();
    expect(maplibreTest.instances[1]?.addControl).toHaveBeenCalledWith(
      maplibreTest.scales[1],
      "bottom-left",
    );
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
    const map = maplibreTest.instances[0];
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

  it("persists the viewport for a user-originated move", async () => {
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
});

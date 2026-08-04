// @vitest-environment jsdom

import { act, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalConsoleError = console.error;

vi.mock("@mui/material/styles", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@mui/material/styles")>()),
  useColorScheme: () => ({ mode: "light", systemMode: "light" }),
}));

vi.mock("next-intl", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next-intl")>()),
  useLocale: () => "en",
}));

vi.mock("@/lib/EnvProvider", () => {
  const env = {
    apiUrl: "",
    mapStyleUrl: "",
    styleProvider: "openmapx",
    tilesUrl: "",
  };
  return { useEnv: () => env };
});

vi.mock("@/lib/MapContext", () => {
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
    layers: [],
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
    reset() {
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
  const options: Array<{ center: [number, number]; container: HTMLElement; zoom: number }> = [];
  const workerUrlsAtConstruction: string[] = [];
  let workerUrl = "";
  let setupError: Error | undefined;
  let setupErrorOnCall = 1;
  let onCallCount = 0;
  class FakeMap {
    jumpTo = vi.fn();

    constructor(mapOptions: { center: [number, number]; container: HTMLElement; zoom: number }) {
      instances.push(this);
      options.push(mapOptions);
      workerUrlsAtConstruction.push(workerUrl);
      mapOptions.container.append(document.createElement("canvas"));
    }

    isStyleLoaded = () => true;
    off = vi.fn();
    on = vi.fn(() => {
      onCallCount += 1;
      if (!setupError || onCallCount !== setupErrorOnCall) return;
      const error = setupError;
      setupError = undefined;
      throw error;
    });
    once = vi.fn();
    remove = vi.fn();
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
      reset() {
        instances.length = 0;
        options.length = 0;
        workerUrlsAtConstruction.length = 0;
        workerUrl = "";
        setupError = undefined;
        setupErrorOnCall = 1;
        onCallCount = 0;
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

import { useMapStore } from "@openmapx/core";
import * as maplibre from "maplibre-gl";
import * as mapContext from "@/lib/MapContext";
import * as mapStyle from "@/lib/map";
import { MapCanvas } from "./MapCanvas";

const maplibreTest = (
  maplibre as unknown as {
    __test: {
      instances: Array<{
        jumpTo: ReturnType<typeof vi.fn>;
        remove: ReturnType<typeof vi.fn>;
      }>;
      options: Array<{ center: [number, number]; zoom: number }>;
      workerUrlsAtConstruction: string[];
      failSetup(error: Error, onCall?: number): void;
      reset(): void;
    };
  }
).__test;
const mapStyleTest = (
  mapStyle as unknown as {
    __test: { deferStyle(): () => void; reset(): void };
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
});

describe("MapCanvas", () => {
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
    expect(mapContextTest.mapRef.current).toBeNull();
    expect(mapContextTest.notifyMapReady).not.toHaveBeenCalled();
  });
});

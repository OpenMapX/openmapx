// @vitest-environment jsdom

import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OfflinePackageRecord } from "@/lib/offlineAreas";

vi.mock("@/lib/EnvProvider", () => ({
  useEnv: () => ({ styleProvider: "openmapx", tilesUrl: "" }),
}));

vi.mock("@mui/material/styles", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@mui/material/styles")>()),
  useColorScheme: () => ({ mode: "light", systemMode: "light" }),
}));

vi.mock("@/lib/map", () => ({
  baseMapCreditsHtml: () => [],
  loadOpenMapXStyle: vi.fn().mockResolvedValue({
    version: 8,
    sources: { openmaptiles: { type: "vector", tiles: [] } },
    layers: [],
  }),
}));
vi.mock("@/components/map/MapCredits", () => ({ MapCredits: () => null }));
vi.mock("@/lib/offlineAreas", () => {
  const refresh = vi.fn().mockResolvedValue(undefined);
  const register = vi.fn().mockReturnValue(vi.fn());
  return {
    __test: { refresh, register },
    configureDefaultOfflinePackageResolver: vi.fn(),
    getDefaultOfflinePackageResolver: () => ({ refresh }),
    registerOfflinePmtilesProtocol: register,
  };
});

vi.mock("maplibre-gl", () => {
  let workerUrl = "";
  class FakeMap {
    static workerUrlsAtConstruction: string[] = [];

    touchZoomRotate = { disableRotation: vi.fn() };
    keyboard = { disableRotation: vi.fn() };
    on = vi.fn();
    remove = vi.fn();

    constructor() {
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
import * as offlineAreas from "@/lib/offlineAreas";
import { OfflineMapView } from "./OfflineMapView";

const mocks = (
  offlineAreas as unknown as {
    __test: {
      refresh: ReturnType<typeof vi.fn>;
      register: ReturnType<typeof vi.fn>;
    };
  }
).__test;
const fakeMapClass = maplibregl.Map as unknown as { workerUrlsAtConstruction: string[] };

const record = {
  id: `omp2-${"d".repeat(64)}`,
  name: "Test area",
  status: "ready",
  manifest: {
    dataset: { version: "dataset-v1", tileSchema: "openmaptiles" },
    glyphs: { version: "glyphs-v1" },
    coverage: { bbox: { west: 0, south: 0, east: 1, north: 1 } },
  },
} as OfflinePackageRecord;

afterEach(() => {
  fakeMapClass.workerUrlsAtConstruction.length = 0;
  vi.clearAllMocks();
});

describe("OfflineMapView", () => {
  it("refreshes an existing resolver before creating the map", async () => {
    render(<OfflineMapView packages={[record]} />);

    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    expect(mocks.register).toHaveBeenCalledTimes(1);
    expect(fakeMapClass.workerUrlsAtConstruction).toEqual([
      "/runtime/maplibre-gl/6.1.0/maplibre-gl-worker.mjs",
    ]);
  });
});

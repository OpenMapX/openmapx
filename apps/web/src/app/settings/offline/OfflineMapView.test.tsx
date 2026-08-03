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

vi.mock("@/lib/map", () => ({ baseMapCreditsHtml: () => [] }));
vi.mock("@/components/map/MapCredits", () => ({ MapCredits: () => null }));
vi.mock("@/lib/offlineAreas", () => {
  const refresh = vi.fn().mockResolvedValue(undefined);
  const register = vi.fn().mockReturnValue(vi.fn());
  const resolveStyle = vi.fn().mockResolvedValue({
    version: 8,
    sources: { openmaptiles: { type: "vector", tiles: [] } },
    layers: [],
  });
  return {
    __test: { refresh, register, resolveStyle },
    configureDefaultOfflinePackageResolver: vi.fn(),
    getDefaultOfflinePackageResolver: () => ({ refresh }),
    registerOfflinePmtilesProtocol: register,
    resolveOfflinePackageStyle: resolveStyle,
  };
});

vi.mock("maplibre-gl", () => {
  class FakeMap {
    touchZoomRotate = { disableRotation: vi.fn() };
    keyboard = { disableRotation: vi.fn() };
    on = vi.fn();
    remove = vi.fn();
  }
  return { default: { Map: FakeMap } };
});

import * as offlineAreas from "@/lib/offlineAreas";
import { OfflineMapView } from "./OfflineMapView";

const mocks = (
  offlineAreas as unknown as {
    __test: {
      refresh: ReturnType<typeof vi.fn>;
      register: ReturnType<typeof vi.fn>;
      resolveStyle: ReturnType<typeof vi.fn>;
    };
  }
).__test;

const record = {
  id: `omp1-${"d".repeat(64)}`,
  name: "Test area",
  status: "ready",
  manifest: {
    dataset: { version: "dataset-v1", tileSchema: "openmaptiles" },
    style: { version: "style-v1" },
    coverage: { bbox: { west: 0, south: 0, east: 1, north: 1 } },
  },
} as OfflinePackageRecord;

afterEach(() => {
  vi.clearAllMocks();
});

describe("OfflineMapView", () => {
  it("refreshes an existing resolver before creating the map", async () => {
    render(<OfflineMapView packages={[record]} />);

    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    expect(mocks.register).toHaveBeenCalledTimes(1);
  });
});

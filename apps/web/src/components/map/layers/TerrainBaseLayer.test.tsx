import { useLayerStore } from "@openmapx/core";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeMap, type FakeMap } from "@/test";
import { TerrainBaseLayer } from "./TerrainBaseLayer";

let fake: FakeMap;
let terrain: unknown;
let resolveTileUrl: (url: string) => void;
let rejectTileUrl: (reason: Error) => void;
let tileUrl: Promise<string>;
const generated = vi.fn(() => Promise.resolve("dem-contour://test/{z}/{x}/{y}"));
vi.mock("./generatedContours", () => ({
  contourDemTileUrl: () => tileUrl,
  generatedContourUrl: (...args: unknown[]) => generated(...args),
}));
vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ mapRef: { current: fake.map }, mapReady: true, styleVersion: 0 }),
}));
vi.mock("@mui/material/styles", () => ({ useColorScheme: () => ({ mode: "light" }) }));
vi.mock("@/integration-api/overlay/useMapAttributions", () => ({ useMapAttributions: () => {} }));
vi.mock("@/lib/offlineAreas", () => ({ useOfflinePackageActive: () => false }));
vi.mock("@/integration-api/runtime/EnvProvider", () => ({
  useEnv: () => ({
    terrainDemTilejsonUrl: "https://example.test/dem.json",
    terrainDemEncoding: "terrarium",
    terrainContourMode: "generated",
    terrainContourTilejsonUrl: "",
  }),
}));

beforeEach(() => {
  fake = createFakeMap();
  terrain = null;
  Object.assign(fake.map, {
    getTerrain: () => terrain,
    setTerrain: (value: unknown) => {
      terrain = value;
    },
  });
  tileUrl = new Promise((resolve, reject) => {
    resolveTileUrl = resolve;
    rejectTileUrl = reject;
  });
  generated.mockClear();
  generated.mockImplementation(() => Promise.resolve("dem-contour://test/{z}/{x}/{y}"));
  useLayerStore.getState().setActiveLayer("terrain");
});
afterEach(cleanup);

describe("optional generated contours", () => {
  it("enables elevation and hillshade before TileJSON resolves, then adds contours", async () => {
    render(<TerrainBaseLayer />);
    expect(terrain).toEqual({ source: "openmapx-terrain-dem", exaggeration: 1 });
    expect(fake.map.getLayer("openmapx-terrain-hillshade")).toBeTruthy();
    expect(fake.map.getLayer("openmapx-terrain-contour-lines")).toBeFalsy();
    await act(async () => resolveTileUrl("https://example.test/{z}/{x}/{y}.png"));
    expect(fake.map.getLayer("openmapx-terrain-contour-lines")).toBeTruthy();
  });

  it("keeps elevation after optional setup fails", async () => {
    render(<TerrainBaseLayer />);
    await act(async () => rejectTileUrl(new Error("unavailable")));
    expect(terrain).toEqual({ source: "openmapx-terrain-dem", exaggeration: 1 });
    expect(fake.map.getLayer("openmapx-terrain-hillshade")).toBeTruthy();
  });

  it("ignores setup completing after a basemap change", async () => {
    render(<TerrainBaseLayer />);
    act(() => useLayerStore.getState().setActiveLayer("satellite"));
    await act(async () => resolveTileUrl("https://example.test/{z}/{x}/{y}.png"));
    expect(terrain).toBeNull();
    expect(generated).not.toHaveBeenCalled();
    expect(fake.map.getLayer("openmapx-terrain-contour-lines")).toBeFalsy();
  });

  it("does not initialize a contour worker after unmount", async () => {
    const { unmount } = render(<TerrainBaseLayer />);
    unmount();
    await act(async () => resolveTileUrl("https://example.test/{z}/{x}/{y}.png"));
    expect(generated).not.toHaveBeenCalled();
  });

  it("ignores a worker URL resolving after a basemap change", async () => {
    let resolveWorker!: (url: string) => void;
    generated.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveWorker = resolve;
        }),
    );
    render(<TerrainBaseLayer />);
    await act(async () => resolveTileUrl("https://example.test/{z}/{x}/{y}.png"));
    expect(generated).toHaveBeenCalledTimes(1);
    expect(terrain).toEqual({ source: "openmapx-terrain-dem", exaggeration: 1 });
    act(() => useLayerStore.getState().setActiveLayer("satellite"));
    await act(async () => resolveWorker("dem-contour://test/{z}/{x}/{y}"));
    expect(terrain).toBeNull();
    expect(fake.map.getLayer("openmapx-terrain-contour-lines")).toBeFalsy();
  });
});

// @vitest-environment node
import type { Map as MapLibreMap, RasterDEMTileSource } from "maplibre-gl";
import { describe, expect, it, vi } from "vitest";
import {
  addAttributedRasterSource,
  retainedDemContributors,
  updateRasterAcquisitionContributors,
} from "./rasterMapContribution";

const imageRequest = vi.hoisted(() => ({ response: vi.fn() }));
vi.mock("../../../../../node_modules/maplibre-gl/src/util/image_request.ts", () => ({
  ImageRequest: { transformAndGetImage: imageRequest.response },
}));
// Load the installed engine source module rather than a handwritten loadTile
// stand-in. Only image transport/decoding and worker messages are replaced.
const enginePath = "../../../../../node_modules/maplibre-gl/src/source/raster_dem_tile_source.ts";
const tileIdPath = "../../../../../node_modules/maplibre-gl/src/tile/tile_id.ts";
const tilePath = "../../../../../node_modules/maplibre-gl/src/tile/tile.ts";

describe("installed MapLibre DEM acquisition receipt", () => {
  it("captures real decoded commits, preserves failed/empty reloads and replaces a successful generation", async () => {
    const [{ RasterDEMTileSource: EngineSource }, { OverscaledTileID }, { Tile }] =
      await Promise.all([import(enginePath), import(tileIdPath), import(tilePath)]);
    let decoded = { data: new Uint8Array(4), generation: "old" };
    const actor = { sendAsync: async () => decoded };
    const source = new EngineSource(
      "dem",
      { type: "raster-dem", tiles: ["https://test/{z}/{x}/{y}"] },
      {
        waitForInitComplete: async () => {},
        getReadyActor: () => actor,
      },
    );
    Object.assign(source, {
      tiles: ["https://test/{z}/{x}/{y}"],
      map: {
        getPixelRatio: () => 1,
        _requestManager: {},
        _refreshExpiredTiles: false,
        style: { projection: { worldCoordinateHelper: {} } },
      },
      readImageNow: async () => ({ width: 1, height: 1, data: new Uint8Array(4) }),
    });
    const sources = new Map<string, RasterDEMTileSource>();
    const map = {
      addSource: (id: string) => sources.set(id, source),
      getSource: (id: string) => sources.get(id),
    } as unknown as MapLibreMap;
    const old = [{ sourceId: "dem", name: "old decoded notice" }];
    addAttributedRasterSource(
      map,
      "dem",
      { type: "raster-dem", tiles: ["https://test/{z}/{x}/{y}"] },
      old,
    );
    const tile = new Tile(new OverscaledTileID(0, 0, 0, 0, 0), 512);
    imageRequest.response.mockRejectedValueOnce(new Error("first failed"));
    await expect(source.loadTile(tile)).rejects.toThrow("first failed");
    expect(retainedDemContributors(map, "dem", tile)).toEqual([]);
    let resolveImage!: (value: unknown) => void;
    const pendingImage = new Promise((resolve) => {
      resolveImage = resolve;
    });
    imageRequest.response.mockImplementation(() => pendingImage);
    const firstSuccessfulLoad = source.loadTile(tile);
    updateRasterAcquisitionContributors(map, "dem", [
      { sourceId: "dem", name: "new decoded notice" },
    ]);
    resolveImage({ data: { width: 1, height: 1 } });
    await firstSuccessfulLoad;
    expect(retainedDemContributors(map, "dem", tile)).toEqual(old);
    imageRequest.response.mockResolvedValue({ data: { width: 1, height: 1 } });
    tile.state = "reloading";
    imageRequest.response.mockRejectedValueOnce(new Error("reload failed"));
    await expect(source.loadTile(tile)).rejects.toThrow("reload failed");
    expect(retainedDemContributors(map, "dem", tile)).toEqual(old);
    imageRequest.response.mockResolvedValue({ data: undefined });
    await source.loadTile(tile);
    expect(retainedDemContributors(map, "dem", tile)).toEqual(old);
    tile.state = "reloading";
    imageRequest.response.mockResolvedValue({ data: { width: 1, height: 1 } });
    decoded = { data: new Uint8Array(4), generation: "new" };
    await source.loadTile(tile);
    expect(retainedDemContributors(map, "dem", tile)).toEqual([
      { sourceId: "dem", name: "new decoded notice" },
    ]);
    await source.unloadTile(tile);
    expect(retainedDemContributors(map, "dem", tile)).toEqual([]);
  });
});

it("uses the installed terrain manager's cached parent covering the currently rendered mesh", async () => {
  const terrainManagerPath =
    "../../../../../node_modules/maplibre-gl/src/tile/terrain_tile_manager.ts";
  const [{ TerrainTileManager }, { OverscaledTileID }, { Tile }] = await Promise.all([
    import(terrainManagerPath),
    import(tileIdPath),
    import(tilePath),
  ]);
  const { demMapContributors } = await import("./demMapContribution");
  const parentId = new OverscaledTileID(0, 0, 0, 0, 0);
  const meshId = new OverscaledTileID(2, 0, 2, 1, 1);
  const parent = new Tile(parentId, 512);
  const source = {
    tileSize: 512,
    minzoom: 0,
    maxzoom: 9,
    async loadTile(tile: Parameters<RasterDEMTileSource["loadTile"]>[0]) {
      tile.dem = { data: new Uint8Array(4) } as unknown as typeof tile.dem;
      tile.state = "loaded";
    },
  };
  // The installed manager owns the cache traversal; the adapter never reads
  // underscore cache fields. This fixture places the successful parent offscreen.
  const manager = new TerrainTileManager({
    _source: source,
    getTileByID: () => undefined,
    _outOfViewCache: { getByKey: (key: string) => (key === parentId.key ? parent : undefined) },
  });
  manager._tiles[meshId.key] = new Tile(meshId, 1024);
  manager._renderableTilesKeys = [meshId.key];
  const map = {
    addSource() {},
    getSource: () => source,
    getTerrain: () => ({ source: "dem" }),
    terrain: { exaggeration: 1, tileManager: manager },
  } as unknown as MapLibreMap;
  addAttributedRasterSource(
    map,
    "dem",
    { type: "raster-dem", tiles: ["https://test/{z}/{x}/{y}"] },
    [{ sourceId: "dem", name: "cached parent notice" }],
  );
  await source.loadTile(parent);
  parent.demTexture = {} as typeof parent.demTexture;
  parent.needsTerrainPrepare = false;
  expect(demMapContributors(map, [], "dem")).toEqual([
    { sourceId: "dem", name: "cached parent notice" },
  ]);
  manager._renderableTilesKeys = [];
  expect(demMapContributors(map, [], "dem")).toEqual([]);
});

it("uses the installed native elevation expression and decoded DEMs to exclude transparent relief", async () => {
  const styleSpecPath =
    "../../../../../node_modules/.pnpm/maplibre-gl@6.13.0/node_modules/@maplibre/maplibre-gl-style-spec/dist/index.mjs";
  const demPath = "../../../../../node_modules/maplibre-gl/src/data/dem_data.ts";
  const imagePath = "../../../../../node_modules/maplibre-gl/src/util/image.ts";
  const [
    { createPropertyExpression, latest },
    { DEMData },
    { RGBAImage },
    { OverscaledTileID },
    { Tile },
  ] = await Promise.all([
    import(styleSpecPath),
    import(demPath),
    import(imagePath),
    import(tileIdPath),
    import(tilePath),
  ]);
  const { demMapContributors } = await import("./demMapContribution");
  const compiled = createPropertyExpression(
    [
      "interpolate",
      ["linear"],
      ["elevation"],
      0,
      "rgba(0,0,0,0)",
      400,
      "rgba(0,0,0,0)",
      800,
      "#ff0000",
      1000,
      "#ff0000",
    ],
    "layers[relief].paint.color-relief-color",
    latest["paint_color-relief"]["color-relief-color"],
  );
  if (compiled.result !== "success") throw new Error("native color ramp compilation failed");
  const layer = {
    id: "relief",
    type: "color-relief",
    source: "dem",
    isHidden: () => false,
    colorRampExpression: compiled.value,
    paint: { get: () => 0.13 },
  };
  const value = new Tile(new OverscaledTileID(0, 0, 0, 0, 0), 512);
  let elevation = 100;
  const source = {
    async loadTile(tile: Parameters<RasterDEMTileSource["loadTile"]>[0]) {
      const data = new Uint8Array(6 * 6 * 4);
      const encoded = 32768 + elevation;
      for (let offset = 0; offset < data.length; offset += 4) {
        data[offset] = Math.floor(encoded / 256);
        data[offset + 1] = encoded % 256;
        data[offset + 3] = 255;
      }
      tile.dem = new DEMData("probe", new RGBAImage({ width: 6, height: 6 }, data), "terrarium");
      tile.state = "loaded";
    },
  };
  const map = {
    addSource() {},
    getSource: () => source,
    getZoom: () => 10,
    getLayer: () => layer,
    getTerrain: () => null,
    style: {
      getLayer: () => layer,
      tileManagers: {
        dem: {
          getVisibleCoordinates: () => [value.tileID],
          getTile: () => value,
        },
      },
    },
  } as unknown as MapLibreMap;
  addAttributedRasterSource(
    map,
    "dem",
    { type: "raster-dem", tiles: ["https://test/{z}/{x}/{y}"] },
    [{ sourceId: "dem", name: "native relief notice" }],
  );
  await source.loadTile(value);
  value.demTexture = {} as typeof value.demTexture;
  value.needsColorReliefPrepare = false;
  expect(demMapContributors(map, [{ layerId: "relief", sourceId: "dem" }])).toEqual([]);
  elevation = 900;
  await source.loadTile(value);
  expect(demMapContributors(map, [{ layerId: "relief", sourceId: "dem" }])).toEqual([
    { sourceId: "dem", name: "native relief notice" },
  ]);
});

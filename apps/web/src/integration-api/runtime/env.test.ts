import { afterEach, describe, expect, it } from "vitest";
import { buildClientEnv } from "./env";

const originalEnv = { ...process.env };
afterEach(() => {
  process.env = { ...originalEnv };
});

describe("terrain defaults", () => {
  it("uses proxied Mapterhorn only with the self-hosted OpenMapX basemap", () => {
    process.env.NEXT_PUBLIC_STYLE_PROVIDER = "openmapx";
    process.env.NEXT_PUBLIC_TILES_URL = "https://example.test/tiles/data/openmapx.json";
    process.env.NEXT_PUBLIC_API_URL = "https://example.test";
    const env = buildClientEnv();
    expect(env.terrainDemTilejsonUrl).toBe("https://example.test/api/mapterhorn/tiles.json");
    expect(env.terrainDemEncoding).toBe("terrarium");
    expect(env.terrainContourMode).toBe("generated");
    expect(env.terrainDemTileUrlTemplate).toBe(
      "https://example.test/api/mapterhorn/{z}/{x}/{y}.webp",
    );
    expect(env.terrainAttributionUrl).toBe("https://mapterhorn.com/attribution/");
  });

  it("keeps MapTiler DEM and contours for a MapTiler basemap", () => {
    process.env.NEXT_PUBLIC_STYLE_PROVIDER = "maptiler";
    process.env.NEXT_PUBLIC_TILES_URL = "https://example.test/tiles/data/openmapx.json";
    const env = buildClientEnv();
    expect(env.terrainDemEncoding).toBe("mapbox");
    expect(env.terrainContourMode).toBe("vector");
    expect(env.terrainDemTilejsonUrl).toContain("/api/maptiler/tiles/terrain-rgb-v2/");
  });

  it("uses Mapterhorn when a MapTiler-compatible style is served locally", () => {
    process.env.NEXT_PUBLIC_STYLE_PROVIDER = "maptiler";
    process.env.NEXT_PUBLIC_MAP_STYLE_URL = "https://example.test/tiles";
    expect(buildClientEnv().terrainDemEncoding).toBe("terrarium");
  });

  it("respects an explicit vector contour source", () => {
    process.env.NEXT_PUBLIC_STYLE_PROVIDER = "openmapx";
    process.env.NEXT_PUBLIC_TILES_URL = "https://example.test/tiles/data/openmapx.json";
    process.env.NEXT_PUBLIC_TERRAIN_CONTOUR_TILEJSON_URL = "/local-contours/tiles.json";
    expect(buildClientEnv().terrainContourMode).toBe("vector");
  });

  it("supports locally served Terrarium DEM with generated contours", () => {
    process.env.NEXT_PUBLIC_STYLE_PROVIDER = "openmapx";
    process.env.NEXT_PUBLIC_TILES_URL = "https://example.test/tiles/data/openmapx.json";
    process.env.NEXT_PUBLIC_TERRAIN_DEM_TILEJSON_URL = "/local-dem/tiles.json";
    process.env.NEXT_PUBLIC_TERRAIN_DEM_TILE_URL_TEMPLATE = "/local-dem/{z}/{x}/{y}.webp";
    process.env.NEXT_PUBLIC_TERRAIN_DEM_ENCODING = "terrarium";
    const env = buildClientEnv();
    expect(env.terrainDemTilejsonUrl).toBe("/local-dem/tiles.json");
    expect(env.terrainDemTileUrlTemplate).toBe("/local-dem/{z}/{x}/{y}.webp");
    expect(env.terrainDemEncoding).toBe("terrarium");
    expect(env.terrainContourMode).toBe("generated");
  });

  it("derives generated contours from custom DEM TileJSON without a separate template", () => {
    process.env.NEXT_PUBLIC_TERRAIN_DEM_TILEJSON_URL = "/local-dem/tiles.json";
    expect(buildClientEnv().terrainContourMode).toBe("generated");
  });
});

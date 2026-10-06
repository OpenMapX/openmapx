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
    process.env.NEXT_PUBLIC_TILES_URL = "";
    const env = buildClientEnv({
      hostedBasemapProvider: "maptiler",
      maptilerConfigured: true,
      selfHostedTilesUrl: "" as const,
      selfHostedGlyphsUrl: "" as const,
    });
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

describe("vector basemap selection", () => {
  const hosted = (provider: "auto" | "openfreemap" | "maptiler", key = false) => ({
    hostedBasemapProvider: provider,
    maptilerConfigured: key,
    selfHostedTilesUrl: "" as const,
    selfHostedGlyphsUrl: "" as const,
  });

  it("defaults to OpenFreeMap with keyless terrain when no key is configured", () => {
    delete process.env.NEXT_PUBLIC_TILES_URL;
    delete process.env.NEXT_PUBLIC_STYLE_PROVIDER;
    delete process.env.NEXT_PUBLIC_MAP_STYLE_URL;
    const env = buildClientEnv(hosted("auto"));
    expect(env.basemapProvider).toBe("openfreemap");
    expect(env.terrainDemTilejsonUrl).toContain("/api/mapterhorn/tiles.json");
    expect(env.terrainContourMode).toBe("generated");
  });

  it("selects MapTiler from the API's effective admin key without exposing it", () => {
    delete process.env.NEXT_PUBLIC_TILES_URL;
    const env = buildClientEnv(hosted("auto", true));
    expect(env.basemapProvider).toBe("maptiler");
    expect(JSON.stringify(env)).not.toContain("maptilerConfigured");
    expect(env.terrainDemEncoding).toBe("mapbox");
  });

  it("honors an explicit OpenFreeMap choice even with a MapTiler key", () => {
    delete process.env.NEXT_PUBLIC_TILES_URL;
    process.env.NEXT_PUBLIC_STYLE_PROVIDER = "maptiler";
    const env = buildClientEnv(hosted("openfreemap", true));
    expect(env.basemapProvider).toBe("openfreemap");
    expect(env.styleProvider).toBe("openmapx");
  });

  it("keeps an explicit MapTiler choice even without a key", () => {
    delete process.env.NEXT_PUBLIC_TILES_URL;
    expect(buildClientEnv(hosted("maptiler")).basemapProvider).toBe("maptiler");
  });

  it("prefers explicit local tiles over every hosted choice and hosted style", () => {
    process.env.NEXT_PUBLIC_TILES_URL = "https://local.test/tiles.json";
    process.env.NEXT_PUBLIC_STYLE_PROVIDER = "maptiler";
    for (const provider of ["auto", "maptiler", "openfreemap"] as const) {
      const env = buildClientEnv(hosted(provider, true));
      expect(env.basemapProvider).toBe("selfhosted");
      expect(env.tilesUrl).toBe("https://local.test/tiles.json");
      expect(env.styleProvider).toBe("openmapx");
    }
  });

  it("uses enabled TileServer GL automatically and keeps local URLs on the public API origin", () => {
    delete process.env.NEXT_PUBLIC_TILES_URL;
    delete process.env.NEXT_PUBLIC_MAP_STYLE_URL;
    process.env.NEXT_PUBLIC_API_URL = "https://maps.test";
    const env = buildClientEnv({
      ...hosted("maptiler", true),
      selfHostedTilesUrl: "/tiles/data/openmapx.json",
      selfHostedGlyphsUrl: "/tiles",
    });
    expect(env.basemapProvider).toBe("selfhosted");
    expect(env.tilesUrl).toBe("https://maps.test/tiles/data/openmapx.json");
    expect(env.mapStyleUrl).toBe("https://maps.test/tiles");
  });
});

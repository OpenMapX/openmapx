import { describe, expect, it, vi } from "vitest";
import { syncTerrainStyle } from "./terrainStyle";

function fakeMap() {
  const sources = new Map<string, unknown>();
  const layers = new Map<
    string,
    { layout?: { visibility?: string }; paint?: Record<string, unknown>; type: string }
  >();
  let terrain: { source: string } | null = null;
  const map = {
    getSource: (id: string) => sources.get(id),
    addSource: vi.fn((...args: unknown[]) => sources.set(args[0] as string, args[1])),
    getLayer: (id: string) => layers.get(id),
    addLayer: vi.fn((...args: unknown[]) => {
      const layer = args[0] as { id: string; type: string };
      layers.set(layer.id, layer);
    }),
    getLayoutProperty: (id: string, property: string) =>
      property === "visibility" ? layers.get(id)?.layout?.visibility : undefined,
    setLayoutProperty: vi.fn((...args: unknown[]) => {
      const [id, , value] = args as [string, string, string];
      const layer = layers.get(id);
      if (layer) layer.layout = { ...layer.layout, visibility: value };
    }),
    getPaintProperty: (id: string, property: string) => layers.get(id)?.paint?.[property],
    setPaintProperty: vi.fn((...args: unknown[]) => {
      const [id, property, value] = args as [string, string, unknown];
      const layer = layers.get(id);
      if (layer) layer.paint = { ...layer.paint, [property]: value };
    }),
    getTerrain: () => terrain,
    setTerrain: vi.fn((...args: unknown[]) => {
      terrain = args[0] as { source: string } | null;
    }),
    getStyle: () => ({
      layers: [
        { id: "landcover", type: "fill" },
        { id: "water", type: "fill", "source-layer": "water" },
        { id: "road", type: "line" },
        { id: "place-label", type: "symbol" },
      ],
    }),
  };
  return {
    map,
    sources,
    layers,
    resetStyle: () => {
      sources.clear();
      layers.clear();
      terrain = null;
    },
  };
}

const options = {
  demUrl: "/api/maptiler/tiles/terrain-rgb-v2/tiles.json",
  contoursUrl: "/api/maptiler/tiles/contours-v2/tiles.json",
  dark: false,
};

describe("terrain on the vector basemap", () => {
  it("adds elevation and contours below roads and labels, and enables 3D terrain", () => {
    const { map, sources } = fakeMap();
    syncTerrainStyle(map as unknown as Parameters<typeof syncTerrainStyle>[0], true, options);
    expect(sources.get("openmapx-terrain-dem")).toMatchObject({
      type: "raster-dem",
      url: options.demUrl,
      encoding: "mapbox",
    });
    expect(sources.get("openmapx-terrain-hillshade-dem")).toMatchObject({
      type: "raster-dem",
      url: options.demUrl,
    });
    expect(sources.get("openmapx-terrain-contours")).toMatchObject({
      type: "vector",
      url: options.contoursUrl,
    });
    expect(map.addLayer).toHaveBeenCalledWith(
      expect.objectContaining({ id: "openmapx-terrain-hillshade", type: "hillshade" }),
      "water",
    );
    expect(map.addLayer).toHaveBeenCalledWith(
      expect.objectContaining({ id: "openmapx-terrain-contour-lines", "source-layer": "contour" }),
      "road",
    );
    expect(map.setTerrain).toHaveBeenCalledWith({
      source: "openmapx-terrain-dem",
      exaggeration: 1,
    });
  });

  it("turns relief off without fetching sources when selected again offline", () => {
    const { map } = fakeMap();
    syncTerrainStyle(map as unknown as Parameters<typeof syncTerrainStyle>[0], false, options);
    expect(map.addSource).not.toHaveBeenCalled();
    syncTerrainStyle(map as unknown as Parameters<typeof syncTerrainStyle>[0], true, options);
    syncTerrainStyle(map as unknown as Parameters<typeof syncTerrainStyle>[0], false, options);
    expect(map.setTerrain).toHaveBeenLastCalledWith(null);
    expect(map.setLayoutProperty).toHaveBeenCalledWith(
      "openmapx-terrain-hillshade",
      "visibility",
      "none",
    );
  });

  it("restores missing layers after a style reload", () => {
    const { map, resetStyle } = fakeMap();
    syncTerrainStyle(map as unknown as Parameters<typeof syncTerrainStyle>[0], true, options);
    resetStyle();
    syncTerrainStyle(map as unknown as Parameters<typeof syncTerrainStyle>[0], true, options);
    expect(map.addLayer).toHaveBeenCalledTimes(6);
    expect(map.addSource).toHaveBeenCalledTimes(6);
    expect(map.setTerrain).toHaveBeenCalledTimes(2);
  });

  it("does not repeatedly mutate the style on styledata", () => {
    const { map } = fakeMap();
    syncTerrainStyle(map as unknown as Parameters<typeof syncTerrainStyle>[0], true, options);
    syncTerrainStyle(map as unknown as Parameters<typeof syncTerrainStyle>[0], true, options);
    expect(map.addSource).toHaveBeenCalledTimes(3);
    expect(map.addLayer).toHaveBeenCalledTimes(3);
    expect(map.setTerrain).toHaveBeenCalledTimes(1);
    expect(map.setPaintProperty).not.toHaveBeenCalled();
  });
});

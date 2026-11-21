import type { TerrainProbe } from "@openmapx/core";
import { LngLat, type Map as MaplibreMap } from "maplibre-gl";

/**
 * Reads MapLibre's terrain the way custom layers need it. MapLibre answers 0
 * where no DEM data has loaded and a coarse parent's height where only that
 * has, so a sample counts only when its data is loaded and the drawn tile has
 * its own height.
 */
export function mapTerrainProbe(map: MaplibreMap): TerrainProbe {
  return {
    enabled: () => !!map.getTerrain(),
    sample: (lngLat) => {
      const terrain = map.terrain;
      if (!terrain) return { state: "none" };
      const point = LngLat.convert(lngLat);
      const { demState } = terrain.getElevationAndDEMStateForLngLat(
        point,
        Math.floor(map.getZoom()),
      );
      const drawn = terrain.getDrawnElevationForLngLat(point, true);
      return { state: demState, ...(drawn === undefined ? {} : { drawn }) };
    },
  };
}

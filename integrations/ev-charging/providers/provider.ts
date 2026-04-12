import type {
  BoundingBox,
  DataSourceDetail,
  DataSourceFilterDef,
  DataSourceMeta,
  DataSourceResult,
} from "@openmapx/core";
import type { DataSourceProvider } from "../../data-source/types.js";
import { deduplicateByCoordinates } from "./dedup.js";
import { getOcmDetail, searchOcm } from "./ocm.js";
import { mapOcmToDetail, mapOcmToResult } from "./ocm-mapper.js";
import { getOsmChargingNode, searchOsmCharging } from "./osm.js";
import { mapOsmToDetail, mapOsmToResult } from "./osm-mapper.js";
import { getEvChargingFilters } from "./reference.js";

const META: DataSourceMeta = {
  minZoom: 8,
  placeCategory: "Charging Station",
  placeCategoryRaw: "charging_station",
  markerStyle: {
    variantColors: {
      slow: "#4CAF50",
      fast: "#FF9800",
      "ultra-rapid": "#F44336",
      unknown: "#9E9E9E",
    },
    defaultColor: "#9E9E9E",
    inactiveOpacity: 0.4,
    iconPath: "M7 2v11h3v9l7-12h-4l4-8H7z",
  },
};

class EvChargingProvider implements DataSourceProvider {
  readonly id = "ev-charging";
  readonly meta = META;
  readonly serviceIds = [];

  async getFilters(): Promise<DataSourceFilterDef[]> {
    return getEvChargingFilters();
  }

  async search(bbox: BoundingBox, filters?: Record<string, unknown>): Promise<DataSourceResult[]> {
    // Query OCM and Overpass in parallel
    const [ocmResult, osmResult] = await Promise.allSettled([
      searchOcm(bbox, filters),
      searchOsmCharging(bbox),
    ]);

    const ocmResults: DataSourceResult[] =
      ocmResult.status === "fulfilled" ? ocmResult.value.map(mapOcmToResult) : [];

    const osmResults: DataSourceResult[] =
      osmResult.status === "fulfilled" ? osmResult.value.map(mapOsmToResult) : [];

    // OCM first for dedup priority
    const combined = [...ocmResults, ...osmResults];
    return deduplicateByCoordinates(combined);
  }

  async getDetail(itemId: string): Promise<DataSourceDetail | null> {
    if (itemId.startsWith("ocm:")) {
      const ocmId = itemId.slice(4);
      const poi = await getOcmDetail(ocmId);
      if (poi) {
        return mapOcmToDetail(poi);
      }
    }

    // For OSM items, fetch the actual node from Overpass
    if (itemId.startsWith("osm:")) {
      const osmId = Number(itemId.slice(4));
      const node = await getOsmChargingNode(osmId);
      if (node) return mapOsmToDetail(node);
    }

    return null;
  }
}

export const evChargingProvider = new EvChargingProvider();

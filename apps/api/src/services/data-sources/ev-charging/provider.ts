import type {
  BoundingBox,
  DataSourceDetail,
  DataSourceFilterDef,
  DataSourceMeta,
  DataSourceResult,
} from "@openmapx/core";
import type { DataSourceProvider } from "../types.js";
import { deduplicateByCoordinates } from "./dedup.js";
import { getOcmDetail, searchOcm } from "./ocm.js";
import { mapOcmToDetail, mapOcmToResult } from "./ocm-mapper.js";
import { getOsmChargingNode, searchOsmCharging } from "./osm.js";
import { mapOsmToDetail, mapOsmToResult } from "./osm-mapper.js";
import { getEvChargingFilters } from "./reference.js";

const META: DataSourceMeta = {
  id: "ev-charging",
  name: "EV Charging",
  attribution: [
    {
      text: "OpenChargeMap",
      url: "https://openchargemap.org",
      license: "CC BY-SA 4.0",
      licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
    },
    {
      text: "OpenStreetMap",
      url: "https://www.openstreetmap.org",
      license: "ODbL",
      licenseUrl: "https://opendatacommons.org/licenses/odbl/",
    },
  ],
  categoryChipLabel: "EV Charging",
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
  readonly id = META.id;
  readonly meta = META;

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
    const deduped = deduplicateByCoordinates(combined);

    // Apply speed filter client-side (OCM doesn't natively filter by power range)
    if (filters?.speed) {
      const speedValues = Array.isArray(filters.speed)
        ? (filters.speed as string[])
        : [String(filters.speed)];
      if (speedValues.length > 0) {
        const speedSet = new Set(speedValues);
        return deduped.filter((r) => speedSet.has(r.variant));
      }
    }

    return deduped;
  }

  async getDetail(itemId: string): Promise<DataSourceDetail> {
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

    // Fallback if nothing found
    return {
      id: itemId,
      source: "unknown",
      name: "EV Charging Station",
      coordinates: [0, 0],
      attribution: Array.isArray(META.attribution) ? META.attribution[0] : META.attribution,
      sections: [],
    };
  }
}

export const evChargingProvider = new EvChargingProvider();

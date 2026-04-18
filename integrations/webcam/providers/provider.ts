import type {
  BoundingBox,
  DataSourceDetail,
  DataSourceFilterDef,
  DataSourceMeta,
  DataSourceResult,
} from "@openmapx/core";
import type { DataSourceProvider } from "../../data-source/types.js";
import {
  getCaltransDetail,
  mapCaltransToDetail,
  mapCaltransToResult,
  searchCaltrans,
} from "./caltrans.js";
import { deduplicateByCoordinates } from "./dedup.js";
import {
  getDotDetail,
  getDotSourceIds,
  mapDotToDetail,
  mapDotToResult,
  searchDot,
} from "./dot/index.js";
import { getNpsDetail, mapNpsToDetail, mapNpsToResult, searchNps } from "./nps.js";
import { getOsmWebcamNode, mapOsmToDetail, mapOsmToResult, searchOsmWebcams } from "./osm.js";
import { getTflDetail, mapTflToDetail, mapTflToResult, searchTfl } from "./tfl.js";
import type { RawWebcam } from "./types.js";
import { getWindyDetail, mapWindyToDetail, mapWindyToResult, searchWindy } from "./windy.js";

const META: DataSourceMeta = {
  minZoom: 8,
  placeCategory: "Webcam",
  placeCategoryRaw: "webcam",
  markerStyle: {
    variantColors: {
      landscape: "#4CAF50",
      traffic: "#FF9800",
      city: "#2196F3",
      weather: "#9C27B0",
      beach: "#00BCD4",
      other: "#9E9E9E",
    },
    defaultColor: "#9E9E9E",
    inactiveOpacity: 0.4,
    iconPath:
      "M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z",
  },
};

function buildSourceFilterOptions(): { id: string; label: string }[] {
  return [
    { id: "windy", label: "Windy" },
    { id: "osm", label: "OpenStreetMap" },
    { id: "caltrans", label: "Caltrans" },
    { id: "tfl", label: "TfL London" },
    { id: "nps", label: "US National Parks" },
    ...getDotSourceIds(),
  ];
}

function buildFilters(): DataSourceFilterDef[] {
  return [
    {
      id: "category",
      label: "Category",
      type: "multi-select",
      options: [
        { id: "landscape", label: "Landscape" },
        { id: "traffic", label: "Traffic" },
        { id: "city", label: "City" },
        { id: "weather", label: "Weather" },
        { id: "beach", label: "Beach" },
        { id: "other", label: "Other" },
      ],
    },
    {
      id: "source",
      label: "Source",
      type: "multi-select",
      clientSide: true,
      options: buildSourceFilterOptions(),
    },
  ];
}

type MapToResult = (raw: RawWebcam) => DataSourceResult;

class WebcamProvider implements DataSourceProvider {
  readonly id = "webcam";
  readonly meta = META;
  readonly serviceIds = [];
  readonly searchCacheTtl = 3600;
  readonly detailCacheTtl = 300;

  async getFilters(): Promise<DataSourceFilterDef[]> {
    return buildFilters();
  }

  async search(bbox: BoundingBox, filters?: Record<string, unknown>): Promise<DataSourceResult[]> {
    const [windyResult, osmResult, caltransResult, tflResult, npsResult, dotResult] =
      await Promise.allSettled([
        searchWindy(bbox),
        searchOsmWebcams(bbox),
        searchCaltrans(bbox),
        searchTfl(bbox),
        searchNps(bbox),
        searchDot(bbox),
      ]);

    const mapAndCollect = (
      result: PromiseSettledResult<RawWebcam[]>,
      mapper: MapToResult,
    ): DataSourceResult[] => (result.status === "fulfilled" ? result.value.map(mapper) : []);

    // Priority order: Windy > Caltrans > TfL > NPS > State DOTs > OSM
    const combined = [
      ...mapAndCollect(windyResult, mapWindyToResult),
      ...mapAndCollect(caltransResult, mapCaltransToResult),
      ...mapAndCollect(tflResult, mapTflToResult),
      ...mapAndCollect(npsResult, mapNpsToResult),
      ...mapAndCollect(dotResult, mapDotToResult),
      ...mapAndCollect(osmResult, mapOsmToResult),
    ];

    let results = deduplicateByCoordinates(combined);

    // Apply category filter server-side
    if (filters?.category) {
      const cats = Array.isArray(filters.category)
        ? (filters.category as string[])
        : [String(filters.category)];
      if (cats.length > 0) {
        const catSet = new Set(cats);
        results = results.filter((r) => catSet.has(r.variant));
      }
    }

    return results;
  }

  async getDetail(itemId: string): Promise<DataSourceDetail | null> {
    if (itemId.startsWith("windy:")) {
      const webcamId = itemId.slice("windy:".length);
      const raw = await getWindyDetail(webcamId);
      return raw ? mapWindyToDetail(raw) : null;
    }

    if (itemId.startsWith("osm-webcam:")) {
      const nodeId = Number.parseInt(itemId.slice("osm-webcam:".length), 10);
      if (Number.isNaN(nodeId)) return null;
      const raw = await getOsmWebcamNode(nodeId);
      return raw ? await mapOsmToDetail(raw) : null;
    }

    if (itemId.startsWith("caltrans:")) {
      const rest = itemId.slice("caltrans:".length);
      const colonIdx = rest.indexOf(":");
      if (colonIdx < 0) return null;
      const districtId = rest.slice(0, colonIdx);
      const index = rest.slice(colonIdx + 1);
      const raw = await getCaltransDetail(districtId, index);
      return raw ? mapCaltransToDetail(raw) : null;
    }

    if (itemId.startsWith("tfl:")) {
      const cameraId = itemId.slice("tfl:".length);
      const raw = await getTflDetail(cameraId);
      return raw ? mapTflToDetail(raw) : null;
    }

    if (itemId.startsWith("nps:")) {
      const webcamId = itemId.slice("nps:".length);
      const raw = await getNpsDetail(webcamId);
      return raw ? mapNpsToDetail(raw) : null;
    }

    if (itemId.startsWith("dot-")) {
      const raw = await getDotDetail(itemId);
      return raw ? mapDotToDetail(raw) : null;
    }

    return null;
  }
}

export const webcamProvider = new WebcamProvider();

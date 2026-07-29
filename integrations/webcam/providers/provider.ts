import type {
  BoundingBox,
  DataSourceDetail,
  DataSourceFilterDef,
  DataSourceMeta,
  DataSourceResult,
} from "@openmapx/core";
import {
  createManifestAttribution,
  type MobilityDataSourceProvider,
} from "@openmapx/integration-framework";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { freshnessNow } from "@openmapx/mobility-core/freshness";
import { type MobilityResult, withAttribution } from "@openmapx/mobility-core/result";
import {
  getCameraSourceDetail,
  getCameraSourceIds,
  mapCameraSourceToDetail,
  mapCameraSourceToResult,
  searchCameraSources,
} from "./camera-sources.js";
import { deduplicateByCoordinates } from "./dedup.js";
import { getTflDetail, mapTflToDetail, mapTflToResult, searchTfl } from "./gb-eng-tfl.js";
import { getOsmWebcamNode, mapOsmToDetail, mapOsmToResult, searchOsmWebcams } from "./osm.js";
import type { RawWebcam } from "./types.js";
import {
  getCaltransDetail,
  mapCaltransToDetail,
  mapCaltransToResult,
  searchCaltrans,
} from "./us-ca-caltrans.js";
import { getNpsDetail, mapNpsToDetail, mapNpsToResult, searchNps } from "./us-nps.js";
import {
  getUsStateSourceDetail,
  getUsStateSourceIds,
  mapUsStateSourceToDetail,
  mapUsStateSourceToResult,
  searchUsStateSources,
} from "./us-state-sources.js";
import { getWindyDetail, mapWindyToDetail, mapWindyToResult, searchWindy } from "./windy.js";

// Manifest-driven attribution. Populated by `setManifestDataSources` during
// `setup(ctx)` from `ctx.manifest.dataSources`.
const attribution = createManifestAttribution();
export const setManifestDataSources = attribution.set;

const wrapStatic = <T>(data: T, attributions: Attribution[]): MobilityResult<T> =>
  withAttribution(data, attributions, freshnessNow({ hasRealtimeData: false }));

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
    { id: "us-ca-caltrans", label: "Caltrans" },
    { id: "gb-eng-tfl", label: "TfL London" },
    { id: "us-nps", label: "US National Parks" },
    ...getUsStateSourceIds(),
    ...getCameraSourceIds(),
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

class WebcamProvider implements MobilityDataSourceProvider {
  readonly id = "webcam";
  readonly meta = META;
  readonly serviceIds = [];
  readonly searchCacheTtl = 3600;
  readonly detailCacheTtl = 300;
  get attribution(): Attribution[] {
    return attribution.all();
  }

  async getFilters(): Promise<DataSourceFilterDef[]> {
    return buildFilters();
  }

  async search(
    bbox: BoundingBox,
    filters?: Record<string, unknown>,
  ): Promise<MobilityResult<DataSourceResult[]>> {
    const [
      windyResult,
      osmResult,
      caltransResult,
      tflResult,
      npsResult,
      usStateResult,
      cameraSourceResult,
    ] = await Promise.allSettled([
      searchWindy(bbox),
      searchOsmWebcams(bbox),
      searchCaltrans(bbox),
      searchTfl(bbox),
      searchNps(bbox),
      searchUsStateSources(bbox),
      searchCameraSources(bbox),
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
      ...mapAndCollect(usStateResult, mapUsStateSourceToResult),
      ...mapAndCollect(cameraSourceResult, mapCameraSourceToResult),
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

    return wrapStatic(
      results,
      attribution.forResults(results, (r) => r.sources ?? r.source),
    );
  }

  async getDetail(itemId: string): Promise<MobilityResult<DataSourceDetail | null>> {
    const detail = await this.fetchDetail(itemId);
    const attrs = detail ? attribution.forResults([detail], (d) => d.sources) : [];
    return wrapStatic(detail, attrs);
  }

  private async fetchDetail(itemId: string): Promise<DataSourceDetail | null> {
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

    if (itemId.startsWith("us-ca-caltrans:")) {
      const rest = itemId.slice("us-ca-caltrans:".length);
      const colonIdx = rest.indexOf(":");
      if (colonIdx < 0) return null;
      const districtId = rest.slice(0, colonIdx);
      const index = rest.slice(colonIdx + 1);
      const raw = await getCaltransDetail(districtId, index);
      return raw ? mapCaltransToDetail(raw) : null;
    }

    if (itemId.startsWith("gb-eng-tfl:")) {
      const cameraId = itemId.slice("gb-eng-tfl:".length);
      const raw = await getTflDetail(cameraId);
      return raw ? mapTflToDetail(raw) : null;
    }

    if (itemId.startsWith("us-nps:")) {
      const webcamId = itemId.slice("us-nps:".length);
      const raw = await getNpsDetail(webcamId);
      return raw ? mapNpsToDetail(raw) : null;
    }

    if (getUsStateSourceIds().some((source) => itemId.startsWith(`${source.id}:`))) {
      const stateRaw = await getUsStateSourceDetail(itemId);
      return stateRaw ? mapUsStateSourceToDetail(stateRaw) : null;
    }

    const sourceRaw = await getCameraSourceDetail(itemId);
    return sourceRaw ? mapCameraSourceToDetail(sourceRaw) : null;
  }
}

export const webcamProvider = new WebcamProvider();

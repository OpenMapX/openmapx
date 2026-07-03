import { fetchJson } from "@openmapx/core";
import type { RawWebcam } from "../types.js";
import type { StateDotConfig } from "./types.js";

interface TripCheckFeature {
  attributes: {
    cameraId: number;
    publishedImageId: number;
    filename: string;
    iconType: number;
    latitude: number;
    longitude: number;
    route: string;
    title: string;
    videoId: number;
  };
  geometry: { x: number; y: number };
}

interface TripCheckResponse {
  features: TripCheckFeature[];
}

const IMAGE_BASE = "https://tripcheck.com/RoadCams/cams/";

export const or: StateDotConfig = {
  stateCode: "or",
  stateName: "Oregon",
  sourceId: "dot-or",
  bbox: { south: 41.9, west: -124.7, north: 46.3, east: -116.5 },
  requiresApiKey: false,

  async fetchCameras(): Promise<RawWebcam[]> {
    const data = await fetchJson<TripCheckResponse>(
      "https://tripcheck.com/Scripts/map/data/cctvinventory.js",
      { timeoutMs: 15_000, errorMessage: ({ status }) => `Oregon TripCheck error: ${status}` },
    );
    if (!data?.features) return [];

    const results: RawWebcam[] = [];

    for (const feature of data.features) {
      const a = feature.attributes;
      if (!a.latitude || !a.longitude) continue;

      results.push({
        id: `dot-or:${a.cameraId}`,
        name: a.title,
        coordinates: [a.longitude, a.latitude],
        source: "dot-or",
        variant: "traffic",
        thumbnailUrl: `${IMAGE_BASE}${a.filename}`,
        direction: a.route?.trim() || undefined,
        location: {
          region: a.route?.trim() || undefined,
          country: "US",
        },
      });
    }

    return results;
  },
};

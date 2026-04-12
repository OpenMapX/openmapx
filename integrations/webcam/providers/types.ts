import type { LngLat } from "@openmapx/core";

export type WebcamVariant = "landscape" | "traffic" | "city" | "weather" | "beach" | "other";

export interface WindyWebcam {
  webcamId: number;
  title: string;
  status: string;
  viewCount: number;
  lastUpdatedOn: string;
  images?: {
    current?: { icon?: string; thumbnail?: string; preview?: string };
    daylight?: { icon?: string; thumbnail?: string; preview?: string };
    sizes?: Record<string, { width: number; height: number }>;
  };
  location?: {
    latitude: number;
    longitude: number;
    city?: string;
    region?: string;
    country?: string;
    continent?: string;
  };
  player?: {
    live?: string;
    day?: string;
    month?: string;
    year?: string;
    lifetime?: string;
  };
  urls?: {
    detail?: string;
    edit?: string;
    provider?: string;
  };
  categories?: { id: string; name: string }[];
}

export interface WindySearchResponse {
  total: number;
  webcams: WindyWebcam[];
}

export interface OsmWebcam {
  id: number;
  lat: number;
  lon: number;
  tags: Record<string, string>;
}

export interface CaltransCctv {
  cctv: {
    index: string;
    recordTimestamp?: {
      recordDate?: string;
      recordTime?: string;
      recordEpoch?: string;
    };
    location: {
      district: string;
      locationName: string;
      nearbyPlace?: string;
      longitude: string;
      latitude: string;
      elevation?: string;
      direction?: string;
      county?: string;
      route?: string;
    };
    inService: string;
    imageData?: {
      imageDescription?: string;
      streamingVideoURL?: string;
      static?: {
        currentImageUpdateFrequency?: string;
        currentImageURL?: string;
      };
    };
  };
}

export interface CaltransDistrictResponse {
  data: CaltransCctv[];
}

export interface TflJamCam {
  id: string;
  commonName: string;
  placeType: string;
  lat: number;
  lon: number;
  additionalProperties: { key: string; value: string }[];
}

export interface RawWebcam {
  id: string;
  name: string;
  coordinates: LngLat;
  source: string;
  variant: WebcamVariant;
  thumbnailUrl?: string;
  streamUrl?: string;
  playerEmbedUrl?: string;
  detailUrl?: string;
  lastUpdated?: string;
  viewCount?: number;
  direction?: string;
  categories?: string[];
  location?: { city?: string; region?: string; country?: string };
}

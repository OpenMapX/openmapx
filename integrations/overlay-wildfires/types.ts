export type WildfireProvider = "nifc" | "effis" | "noaa-hms";

export interface NormalizedViewport {
  west: number;
  south: number;
  east: number;
  north: number;
  zoom: number;
}

export interface WildfireProviderData extends GeoJSON.FeatureCollection {
  source: WildfireProvider;
  truncated: boolean;
}

export interface WildfireFeatureCollection extends WildfireProviderData {
  fetchedAt: string;
  stale: boolean;
}

export interface NifcProperties {
  id: string;
  kind: "reported-perimeter";
  provider: "nifc";
  coverage: "United States";
  name: string;
  areaAcres?: number;
  observedAt?: string;
  updatedAt?: string;
  discoveredAt?: string;
  containmentPercent?: number;
  region?: string;
  cause?: string;
}

export interface EffisProperties {
  id: string;
  kind: "satellite-burned-area";
  provider: "effis";
  detectedAt?: string;
  updatedAt?: string;
  countryCode?: string;
  region?: string;
  locality?: string;
  areaHectares?: number;
  sourceClass?: string;
}

export interface NoaaSmokeProperties {
  id: string;
  kind: "observed-smoke";
  provider: "noaa-hms";
  density: "light" | "medium" | "heavy";
  satellite?: string;
  startedAt?: string;
  endedAt?: string;
}

/** The layer a viewport or world wildfire response feeds; its feature ids carry it as a prefix. */
export type WildfireProvider = "nifc" | "effis" | "noaa-hms";

/** The satellite instrument family of a hotspot. */
export type FirmsInstrument = "viirs" | "modis";
export type FirmsDayRange = 1 | 2 | 3;

export interface FireFeature {
  type: "Feature";
  id: string;
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: {
    latitude: number;
    longitude: number;
    /** Brightness temperature in kelvin, when the detection carries one. */
    brightness: number | null;
    /** Fire radiative power in MW. */
    frp: number;
    /** VIIRS: `low`, `nominal` or `high`; MODIS: a percentage, as text. */
    confidence: string | null;
    satellite: string | null;
    /** `YYYY-MM-DD` and `HHMM`, UTC. */
    acqDate: string;
    acqTime: string;
    dayNight: "D" | "N" | null;
    ageMs: number;
    instrument: FirmsInstrument;
  };
}

export interface FireFeatureCollection {
  type: "FeatureCollection";
  features: FireFeature[];
}

/** Fire detections aggregated into one grid cell, drawn at the cell's centre. */
export interface FireDensityFeature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: {
    count: number;
    /** Summed and largest fire radiative power in MW. */
    frpSum: number;
    frpMax: number;
  };
}

export interface FireDensityCollection {
  type: "FeatureCollection";
  features: FireDensityFeature[];
  /** The feed ids the cells were built from, for the map credits. */
  sources: string[];
}

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
  /** The feed ids behind the features, for the map credits. */
  sources: string[];
}

export interface WildfireFeatureCollection extends WildfireProviderData {
  fetchedAt: string;
  stale: boolean;
}

export interface NifcProperties {
  id: string;
  kind: "reported-perimeter";
  /** The id of the source that reported the perimeter. */
  provider: string;
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
  /** The id of the source that mapped the burned area. */
  provider: string;
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
  /** The id of the source that observed the smoke. */
  provider: string;
  density: "light" | "medium" | "heavy";
  satellite?: string;
  startedAt?: string;
  endedAt?: string;
}

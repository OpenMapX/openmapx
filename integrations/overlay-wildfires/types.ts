export type WildfireProvider = "nifc" | "effis" | "noaa-hms";

export type WildfireSourceFailureKind =
  | "upstream-status"
  | "upstream-payload"
  | "network"
  | "timeout"
  | "feature-cap";

export interface WildfireSourceErrorOptions {
  provider: WildfireProvider;
  kind: WildfireSourceFailureKind;
  upstreamStatus?: number;
  cause?: unknown;
}

/** A known provider failure that public routes may safely translate to a 503. */
export class WildfireSourceError extends Error {
  readonly provider: WildfireProvider;
  readonly kind: WildfireSourceFailureKind;
  readonly upstreamStatus?: number;

  constructor(message: string, options: WildfireSourceErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "WildfireSourceError";
    this.provider = options.provider;
    this.kind = options.kind;
    this.upstreamStatus = options.upstreamStatus;
  }
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

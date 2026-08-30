import type { AirQualityStandardId, Pollutant, ProviderEvidence } from "@openmapx/air-quality";

import type { ProviderCallContext } from "../provider-execution.js";

export type AirQualityCapability =
  | "current"
  | "forecast"
  | "stations"
  | "raster"
  | "published-index"
  | "pollutants";

export interface PointAirQualityQuery {
  latitude: number;
  longitude: number;
  evaluatedAt: string;
  countryCode?: string;
  subdivisionCode?: string;
  comparisonStandard?: AirQualityStandardId;
}

export interface ForecastAirQualityQuery extends PointAirQualityQuery {
  hours: number;
}

export interface StationViewportQuery {
  south: number;
  west: number;
  north: number;
  east: number;
  zoom: number;
  pollutant: Pollutant;
  limit: number;
  cursor?: string;
}

export interface StationEvidencePage {
  evidence: ProviderEvidence[];
  nextCursor: string | null;
  truncated: boolean;
}

export interface RasterTimeAxis {
  frames: Array<{
    at: string;
    kind: "model-past" | "model-current" | "model-forecast";
    updatedAt: string;
  }>;
}

export interface RasterTileQuery {
  z: number;
  x: number;
  y: number;
  time: string;
}

export interface RasterTile {
  bytes: Uint8Array;
  contentType: "image/png";
  etag: string | null;
  frameAt: string;
}

export interface AirQualityProvider {
  readonly id: string;
  readonly sourceIds: readonly string[];
  /** Lower values win only after evidence class and scientific criteria. */
  readonly priority: number;
  readonly timeoutMs?: number;
  readonly capabilities: ReadonlySet<AirQualityCapability>;
  readonly coverage: {
    countries?: readonly string[];
    bbox?: readonly [number, number, number, number];
  };

  getCurrent?(query: PointAirQualityQuery, call: ProviderCallContext): Promise<ProviderEvidence[]>;
  getForecast?(
    query: ForecastAirQualityQuery,
    call: ProviderCallContext,
  ): Promise<ProviderEvidence[]>;
  getStations?(
    query: StationViewportQuery,
    call: ProviderCallContext,
  ): Promise<StationEvidencePage>;
  getRasterTimes?(call: ProviderCallContext): Promise<RasterTimeAxis>;
  getRasterTile?(query: RasterTileQuery, call: ProviderCallContext): Promise<RasterTile>;
}

const capabilities = new Set<AirQualityCapability>([
  "current",
  "forecast",
  "stations",
  "raster",
  "published-index",
  "pollutants",
]);

export function assertAirQualityProviderContract(
  provider: AirQualityProvider,
  allowedSourceIds?: ReadonlySet<string>,
): void {
  if (!provider.id.trim()) throw new TypeError("Air-quality provider id is required");
  if (!Number.isInteger(provider.priority))
    throw new TypeError(`Air-quality provider ${provider.id} priority must be an integer`);
  if (
    provider.sourceIds.length === 0 ||
    new Set(provider.sourceIds).size !== provider.sourceIds.length ||
    provider.sourceIds.some((id) => !id.trim())
  )
    throw new TypeError(`Air-quality provider ${provider.id} must declare unique sourceIds`);
  if (allowedSourceIds) {
    const unknown = provider.sourceIds.filter((sourceId) => !allowedSourceIds.has(sourceId));
    if (unknown.length > 0)
      throw new TypeError(
        `Air-quality provider ${provider.id} uses sourceIds absent from manifest.dataSources: ${unknown.sort().join(", ")}`,
      );
  }
  if (
    provider.timeoutMs !== undefined &&
    (!Number.isInteger(provider.timeoutMs) ||
      provider.timeoutMs < 250 ||
      provider.timeoutMs > 4_500)
  )
    throw new TypeError(
      `Air-quality provider ${provider.id} timeoutMs must be an integer from 250 to 4500`,
    );
  for (const capability of provider.capabilities)
    if (!capabilities.has(capability))
      throw new TypeError(
        `Air-quality provider ${provider.id} has unknown capability: ${capability}`,
      );
  const methodPairs: Array<[AirQualityCapability, boolean]> = [
    ["current", typeof provider.getCurrent === "function"],
    ["forecast", typeof provider.getForecast === "function"],
    ["stations", typeof provider.getStations === "function"],
    [
      "raster",
      typeof provider.getRasterTimes === "function" && typeof provider.getRasterTile === "function",
    ],
  ];
  for (const [capability, methodPresent] of methodPairs) {
    if (provider.capabilities.has(capability) !== methodPresent)
      throw new TypeError(
        `Air-quality provider ${provider.id} capability ${capability} must match its method implementation`,
      );
  }
  if (!methodPairs.some(([capability]) => provider.capabilities.has(capability)))
    throw new TypeError(
      `Air-quality provider ${provider.id} must expose at least one operational capability`,
    );
  if (
    (provider.capabilities.has("published-index") || provider.capabilities.has("pollutants")) &&
    !["current", "forecast", "stations"].some((value) =>
      provider.capabilities.has(value as AirQualityCapability),
    )
  )
    throw new TypeError(
      `Air-quality provider ${provider.id} data capabilities require a point, forecast, or station method`,
    );
  if (!provider.coverage.countries?.length && !provider.coverage.bbox)
    throw new TypeError(`Air-quality provider ${provider.id} must declare geographic coverage`);
  if (provider.coverage.countries?.some((code) => !/^[A-Z]{2}$/.test(code)))
    throw new TypeError(
      `Air-quality provider ${provider.id} coverage countries must be uppercase ISO alpha-2 codes`,
    );
  const bbox = provider.coverage.bbox;
  if (
    bbox &&
    (!bbox.every(Number.isFinite) ||
      bbox[0] < -180 ||
      bbox[2] > 180 ||
      bbox[1] < -90 ||
      bbox[3] > 90 ||
      bbox[0] >= bbox[2] ||
      bbox[1] >= bbox[3])
  )
    throw new TypeError(`Air-quality provider ${provider.id} coverage bbox is invalid`);
}

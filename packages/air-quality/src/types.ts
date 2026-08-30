export type AirQualityStandardId =
  | "us-epa-2024"
  | "eu-eea-current"
  | "uk-daqi-current"
  | "in-naqi-current"
  | "cn-hj633-2026"
  | "ca-aqhi-current";

export type AirQualityProgramId =
  | "us-epa-aqi"
  | "eea-european-aqi"
  | "uk-daqi"
  | "in-naqi"
  | "cn-hj633"
  | "ca-aqhi"
  | "ca-qc-info-smog";

export type Pollutant = "pm25" | "pm10" | "o3" | "no2" | "so2" | "co" | "nh3" | "no";
export type AirQualityUnit = "ug/m3" | "mg/m3" | "ppb" | "ppm";
export type AirQualityBasis = "ground" | "model" | "hybrid";
export type AirQualityAuthority = "official-agency" | "data-owner" | "aggregator";
export type AirQualityIndexAuthority = AirQualityAuthority | "openmapx";
export type AirQualityQualityStatus =
  | "regulatory-certified"
  | "quality-assured"
  | "preliminary"
  | "estimated"
  | "unknown";

export interface PollutantSample {
  startAt: string;
  endAt: string;
  value: number;
  unit: AirQualityUnit;
  valid: boolean;
  estimated: boolean;
  gapFilled: boolean;
}

export interface PollutantSeries {
  seriesId: string;
  coherenceKey: string;
  pollutant: Pollutant;
  sensorId: string | null;
  spatialSupportId: string;
  cadenceMinutes: number | null;
  originalUnit: string;
  samples: PollutantSample[];
}

export interface PublishedIndexInput {
  indexId: string;
  methodId: string;
  methodRevision: string;
  claimedStandardId: AirQualityStandardId | null;
  value: number | null;
  displayValue: string;
  categoryId: string;
  dominantPollutants: Pollutant[];
}

export interface ProviderEvidence {
  observationId: string;
  providerId: string;
  sourceIds: string[];
  dataAuthority: AirQualityAuthority;
  qualityStatus: AirQualityQualityStatus;
  basis: AirQualityBasis;
  originRecords: { sourceId: string; recordId: string }[];
  modelRunId: string | null;
  verticalLevel: string | null;
  series: PollutantSeries[];
  publishedIndices: PublishedIndexInput[];
  observedAt: string | null;
  forecastFor: string | null;
  publishedAt: string | null;
  validUntil: string | null;
  spatial: AirQualitySpatialSupport;
  sources: AirQualitySourceRef[];
}

export interface PollutantWindowSummary {
  pollutant: Pollutant;
  value: number;
  unit: AirQualityUnit;
  originalValue: number;
  originalUnit: string;
  averagingPeriodMinutes: number | null;
  intervalStart: string | null;
  intervalEnd: string;
  sampleCount: number | null;
  expectedSampleCount: number | null;
  completenessPercent: number | null;
  gapFilled: boolean;
  estimated: boolean;
  sensorId: string | null;
}

export interface AirQualityIndex {
  indexId: string;
  standardId: AirQualityStandardId | null;
  standardRevision: string | null;
  methodId: string;
  methodRevision: string;
  effectiveDate: string | null;
  value: number | null;
  displayValue: string;
  categoryId: string;
  dominantPollutants: Pollutant[];
  authority: AirQualityIndexAuthority;
  qualityStatus: AirQualityQualityStatus;
  basis: AirQualityBasis;
  derivation: "published-index" | "openmapx-computed-index";
  inputObservationIds: string[];
}

export interface AirQualityEvidence {
  observationId: string;
  providerId: string;
  sourceIds: string[];
  dataAuthority: AirQualityAuthority;
  qualityStatus: AirQualityQualityStatus;
  basis: AirQualityBasis;
  indices: AirQualityIndex[];
  pollutants: PollutantWindowSummary[];
  observedAt: string | null;
  forecastFor: string | null;
  publishedAt: string | null;
  validUntil: string | null;
  freshness: "fresh" | "stale" | "unknown";
  spatial: AirQualitySpatialSupport;
  completenessByStandard: Partial<
    Record<AirQualityStandardId, { passes: boolean; missingRequirements: string[] }>
  >;
  sources: AirQualitySourceRef[];
  warnings: AirQualityWarningCode[];
}

export interface AirQualitySpatialSupport {
  kind: "station" | "reporting-area" | "community" | "grid-cell";
  id: string;
  name: string | null;
  coordinates: [number, number] | null;
  timeZone: string | null;
  distanceMeters: number | null;
  stationClass: "reference" | "regulatory" | "indicative" | "low-cost" | "unknown" | null;
  mobile: boolean | null;
  coversRequestedPoint: boolean;
  coverageMethod:
    | "provider-point-lookup"
    | "point-in-polygon"
    | "zcta-reporting-area-association"
    | "nearest-station";
}

export interface AirQualitySourceRef {
  sourceId: string;
  name: string;
  url: string | null;
  owner: string | null;
  license: { name: string; url: string | null } | null;
  methodologyUrl: string | null;
  attribution: string | null;
}

export type AirQualitySelectionReason =
  | "local_standard"
  | "published_by_agency"
  | "openmapx_computed"
  | "covers_point"
  | "qualifying_ground_monitor"
  | "fresh"
  | "only_qualifying_index"
  | "raw_fallback";

export type AirQualityRejectionReason =
  | "wrong_standard"
  | "unverified_method"
  | "invalid_schema"
  | "invalid_time"
  | "stale"
  | "does_not_cover_point"
  | "outside_primary_radius"
  | "mobile_sensor"
  | "low_cost_sensor"
  | "unrecognized_station_class"
  | "incomplete_window"
  | "missing_required_pollutant"
  | "unsupported_unit"
  | "incoherent_series"
  | "duplicate_conflict"
  | "policy_disallowed"
  | "provider_unhealthy"
  | "provider_timeout"
  | "quota_exhausted";

export type AirQualityWarningCode =
  | "stale_evidence"
  | "partial_providers"
  | "quota_truncated"
  | "policy_excluded"
  | "duplicate_conflict"
  | "jurisdiction_unresolved"
  | "jurisdiction_hint_mismatch"
  | "comparison_unavailable"
  | "stale_cache"
  | "raster_axis_changed";

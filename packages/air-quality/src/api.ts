import { z } from "zod";

export const airQualityStandardIdSchema = z.enum([
  "us-epa-2024",
  "eu-eea-current",
  "uk-daqi-current",
  "in-naqi-current",
  "cn-hj633-2026",
  "ca-aqhi-current",
]);
export const airQualityProgramIdSchema = z.enum([
  "us-epa-aqi",
  "eea-european-aqi",
  "uk-daqi",
  "in-naqi",
  "cn-hj633",
  "ca-aqhi",
  "ca-qc-info-smog",
]);
export const pollutantSchema = z.enum(["pm25", "pm10", "o3", "no2", "so2", "co", "nh3", "no"]);
export const airQualityUnitSchema = z.enum(["ug/m3", "mg/m3", "ppb", "ppm"]);
export const airQualityBasisSchema = z.enum(["ground", "model", "hybrid"]);
export const airQualityAuthoritySchema = z.enum(["official-agency", "data-owner", "aggregator"]);
export const airQualityIndexAuthoritySchema = z.enum([
  "official-agency",
  "data-owner",
  "aggregator",
  "openmapx",
]);
export const airQualityQualityStatusSchema = z.enum([
  "regulatory-certified",
  "quality-assured",
  "preliminary",
  "estimated",
  "unknown",
]);
export const airQualityFreshnessSchema = z.enum(["fresh", "stale", "unknown"]);
export const airQualityStationClassSchema = z.enum([
  "reference",
  "regulatory",
  "indicative",
  "low-cost",
  "unknown",
]);
export const airQualitySelectionReasonSchema = z.enum([
  "local_standard",
  "published_by_agency",
  "openmapx_computed",
  "covers_point",
  "qualifying_ground_monitor",
  "fresh",
  "only_qualifying_index",
  "raw_fallback",
]);
export const airQualityRejectionReasonSchema = z.enum([
  "wrong_standard",
  "unverified_method",
  "invalid_schema",
  "invalid_time",
  "stale",
  "does_not_cover_point",
  "outside_primary_radius",
  "mobile_sensor",
  "low_cost_sensor",
  "unrecognized_station_class",
  "incomplete_window",
  "missing_required_pollutant",
  "unsupported_unit",
  "incoherent_series",
  "duplicate_conflict",
  "policy_disallowed",
  "provider_unhealthy",
  "provider_timeout",
  "quota_exhausted",
]);
export const airQualityWarningCodeSchema = z.enum([
  "stale_evidence",
  "partial_providers",
  "quota_truncated",
  "policy_excluded",
  "duplicate_conflict",
  "jurisdiction_unresolved",
  "jurisdiction_hint_mismatch",
  "comparison_unavailable",
  "stale_cache",
  "raster_axis_changed",
]);
export const airQualityProviderFailureCodeSchema = z.enum([
  "provider_unhealthy",
  "provider_timeout",
  "quota_exhausted",
  "invalid_schema",
  "invalid_time",
  "upstream_failure",
  "unauthorized",
  "forbidden",
  "cancelled",
  "unknown",
]);

const instantSchema = z.iso.datetime({ offset: true });
const boundedString = z.string().min(1).max(512);
const sourceIdSchema = z.string().min(1).max(128);
const observationIdSchema = z.string().regex(/^obs_1_[A-Za-z0-9_-]{43}$/);
const indexIdSchema = z.string().regex(/^idx_1_[A-Za-z0-9_-]{43}$/);
const stationIdSchema = z.string().regex(/^stn_1_[A-Za-z0-9_-]{43}$/);

export const airQualitySourceRefSchema = z
  .object({
    sourceId: sourceIdSchema,
    name: boundedString,
    url: z.url().nullable(),
    owner: z.string().max(512).nullable(),
    license: z.object({ name: boundedString, url: z.url().nullable() }).strict().nullable(),
    methodologyUrl: z.url().nullable(),
    attribution: z.string().max(1_024).nullable(),
  })
  .strict();

export const airQualitySpatialSupportSchema = z
  .object({
    kind: z.enum(["station", "reporting-area", "community", "grid-cell"]),
    id: boundedString,
    name: z.string().max(512).nullable(),
    coordinates: z
      .tuple([z.number().finite().min(-180).max(180), z.number().finite().min(-90).max(90)])
      .nullable(),
    timeZone: z.string().max(128).nullable(),
    distanceMeters: z.number().finite().nonnegative().nullable(),
    stationClass: airQualityStationClassSchema.nullable(),
    mobile: z.boolean().nullable(),
    coversRequestedPoint: z.boolean(),
    coverageMethod: z.enum([
      "provider-point-lookup",
      "point-in-polygon",
      "zcta-reporting-area-association",
      "nearest-station",
    ]),
  })
  .strict();

export const airQualityIndexSchema = z
  .object({
    indexId: indexIdSchema,
    standardId: airQualityStandardIdSchema.nullable(),
    standardRevision: z.string().min(1).max(256).nullable(),
    methodId: boundedString,
    methodRevision: boundedString,
    effectiveDate: z.iso.date().nullable(),
    value: z.number().finite().nullable(),
    displayValue: z.string().max(128),
    categoryId: boundedString,
    dominantPollutants: z.array(pollutantSchema).max(8),
    authority: airQualityIndexAuthoritySchema,
    qualityStatus: airQualityQualityStatusSchema,
    basis: airQualityBasisSchema,
    derivation: z.enum(["published-index", "openmapx-computed-index"]),
    inputObservationIds: z.array(observationIdSchema).min(1).max(32),
  })
  .strict();

export const pollutantWindowSummarySchema = z
  .object({
    pollutant: pollutantSchema,
    value: z.number().finite(),
    unit: airQualityUnitSchema,
    originalValue: z.number().finite(),
    originalUnit: boundedString,
    averagingPeriodMinutes: z.number().int().positive().nullable(),
    intervalStart: instantSchema.nullable(),
    intervalEnd: instantSchema,
    sampleCount: z.number().int().nonnegative().nullable(),
    expectedSampleCount: z.number().int().nonnegative().nullable(),
    completenessPercent: z.number().finite().min(0).max(100).nullable(),
    gapFilled: z.boolean(),
    estimated: z.boolean(),
    sensorId: z.string().max(256).nullable(),
  })
  .strict();

const completenessSchema = z
  .object({
    passes: z.boolean(),
    missingRequirements: z.array(z.string().min(1).max(512)).max(32),
  })
  .strict();

export const airQualityEvidenceSchema = z
  .object({
    observationId: observationIdSchema,
    providerId: boundedString,
    sourceIds: z.array(sourceIdSchema).min(1).max(32),
    dataAuthority: airQualityAuthoritySchema,
    qualityStatus: airQualityQualityStatusSchema,
    basis: airQualityBasisSchema,
    indices: z.array(airQualityIndexSchema).max(32),
    pollutants: z.array(pollutantWindowSummarySchema).max(64),
    observedAt: instantSchema.nullable(),
    forecastFor: instantSchema.nullable(),
    publishedAt: instantSchema.nullable(),
    validUntil: instantSchema.nullable(),
    freshness: airQualityFreshnessSchema,
    spatial: airQualitySpatialSupportSchema,
    completenessByStandard: z.partialRecord(airQualityStandardIdSchema, completenessSchema),
    sources: z.array(airQualitySourceRefSchema).min(1).max(32),
    warnings: z.array(airQualityWarningCodeSchema).max(32),
  })
  .strict();

export const airQualityJurisdictionSchema = z
  .object({
    countryCode: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .nullable(),
    subdivisionCode: z
      .string()
      .regex(/^[A-Z]{2}-[A-Z0-9]{1,3}$/)
      .nullable(),
    programId: airQualityProgramIdSchema.nullable(),
    resolution: z.enum(["boundary-artifact", "provider-reporting-area", "ambiguous", "unresolved"]),
    resolverId: boundedString,
    resolverRevision: boundedString,
    requestHintMatched: z.boolean().nullable(),
    localStandardId: airQualityStandardIdSchema.nullable(),
  })
  .strict();

export const airQualitySelectionSchema = z
  .object({
    reasons: z.array(airQualitySelectionReasonSchema).max(16),
    rejected: z
      .array(
        z
          .object({
            evidenceId: observationIdSchema,
            indexId: indexIdSchema.nullable(),
            reasons: z.array(airQualityRejectionReasonSchema).max(32),
            missingRequirements: z.array(z.string().min(1).max(512)).max(32),
          })
          .strict(),
      )
      .max(1_024),
  })
  .strict();

export const airQualityResponseMetaSchema = z
  .object({
    generatedAt: instantSchema,
    cache: z.enum(["fresh", "stale", "miss"]),
    providersCandidate: z.array(boundedString).max(128),
    providersServed: z.array(boundedString).max(128),
    providersFailed: z
      .array(
        z.object({ providerId: boundedString, code: airQualityProviderFailureCodeSchema }).strict(),
      )
      .max(128),
    providersPolicyExcluded: z.array(boundedString).max(128),
    truncated: z.boolean(),
    warnings: z.array(airQualityWarningCodeSchema).max(32),
  })
  .strict();

export const airQualityCurrentResponseSchema = z
  .object({
    status: z.enum(["ok", "partial", "unavailable"]),
    jurisdiction: airQualityJurisdictionSchema,
    primaryEvidenceId: observationIdSchema.nullable(),
    primaryIndexId: indexIdSchema.nullable(),
    comparisonStandardId: airQualityStandardIdSchema.nullable(),
    comparisonIndexIds: z.array(indexIdSchema).max(32),
    evidence: z.array(airQualityEvidenceSchema).max(32),
    selection: airQualitySelectionSchema,
    meta: airQualityResponseMetaSchema,
  })
  .strict();

export const airQualityForecastResponseSchema = z
  .object({
    status: z.enum(["ok", "partial", "unavailable"]),
    jurisdiction: airQualityJurisdictionSchema,
    window: z
      .object({
        startAt: instantSchema,
        endAt: instantSchema,
        requestedHours: z.number().int().min(1).max(120),
      })
      .strict(),
    comparisonStandardId: airQualityStandardIdSchema.nullable(),
    evidence: z.array(airQualityEvidenceSchema).max(1_024),
    series: z
      .array(
        z
          .object({
            seriesId: boundedString,
            providerId: boundedString,
            spatialSupportId: boundedString,
            basis: airQualityBasisSchema,
            evidenceIds: z.array(observationIdSchema).max(1_024),
          })
          .strict(),
      )
      .max(1_024),
    frames: z
      .array(
        z
          .object({
            frameAt: instantSchema,
            status: z.enum(["ok", "partial", "unavailable"]),
            evidenceIds: z.array(observationIdSchema).max(1_024),
            primary: z
              .object({ evidenceId: observationIdSchema, indexId: indexIdSchema.nullable() })
              .strict()
              .nullable(),
            comparison: z
              .array(z.object({ evidenceId: observationIdSchema, indexId: indexIdSchema }).strict())
              .max(32),
            selection: airQualitySelectionSchema,
          })
          .strict(),
      )
      .max(121),
    meta: airQualityResponseMetaSchema,
  })
  .strict();

export const airQualityStationFeatureSchema = z
  .object({
    type: z.literal("Feature"),
    id: stationIdSchema,
    geometry: z
      .object({
        type: z.literal("Point"),
        coordinates: z.tuple([
          z.number().finite().min(-180).max(180),
          z.number().finite().min(-90).max(90),
        ]),
      })
      .strict(),
    properties: z
      .object({
        stationId: stationIdSchema,
        name: z.string().max(512).nullable(),
        pollutant: pollutantSchema,
        value: z.number().finite().nonnegative(),
        unit: airQualityUnitSchema,
        intervalStart: instantSchema.nullable(),
        intervalEnd: instantSchema,
        freshness: airQualityFreshnessSchema,
        qualityStatus: airQualityQualityStatusSchema,
        observedAt: instantSchema,
        stationClass: airQualityStationClassSchema.nullable(),
        mobile: z.boolean().nullable(),
        completenessPercent: z.number().finite().min(0).max(100).nullable(),
        estimated: z.boolean(),
        gapFilled: z.boolean(),
        owner: z.string().max(512).nullable(),
        providerId: boundedString,
        sourceIds: z.array(sourceIdSchema).min(1).max(32),
        localIndex: z
          .object({
            indexId: indexIdSchema,
            standardId: airQualityStandardIdSchema,
            value: z.number().finite().nullable(),
            displayValue: z.string().max(128),
            categoryId: boundedString,
          })
          .strict()
          .nullable(),
      })
      .strict(),
  })
  .strict();

export const airQualityStationsResponseSchema = z
  .object({
    type: z.literal("FeatureCollection"),
    features: z.array(airQualityStationFeatureSchema).max(500),
    nextCursor: z.string().min(1).max(2_048).nullable(),
    meta: airQualityResponseMetaSchema
      .extend({
        candidateCount: z.number().int().nonnegative(),
        servedCount: z.number().int().nonnegative(),
        skippedCount: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export const airQualityApiErrorCodeSchema = z.enum([
  "INVALID_QUERY",
  "DOMAIN_DISABLED",
  "CURSOR_EXPIRED",
  "FRAME_UNAVAILABLE",
  "UPSTREAM_INVALID_RESPONSE",
  "NORMALIZED_RESPONSE_TOO_LARGE",
]);

export const airQualityApiErrorSchema = z
  .object({
    code: airQualityApiErrorCodeSchema,
    message: z.string().min(1).max(512),
    details: z
      .record(z.string().min(1).max(128), z.union([z.string(), z.number().finite(), z.boolean()]))
      .optional(),
  })
  .strict();

export type AirQualityCurrentResponse = z.infer<typeof airQualityCurrentResponseSchema>;
export type AirQualityForecastResponse = z.infer<typeof airQualityForecastResponseSchema>;
export type AirQualityStationFeature = z.infer<typeof airQualityStationFeatureSchema>;
export type AirQualityStationsResponse = z.infer<typeof airQualityStationsResponseSchema>;
export type AirQualityApiError = z.infer<typeof airQualityApiErrorSchema>;
export type AirQualityProviderFailureCode = z.infer<typeof airQualityProviderFailureCodeSchema>;

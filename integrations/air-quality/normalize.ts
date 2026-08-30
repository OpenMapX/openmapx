import {
  type AirQualityEvidence,
  type AirQualityIndex,
  type AirQualityRejectionReason,
  type AirQualityStandardId,
  airQualityAuthoritySchema,
  airQualityBasisSchema,
  airQualityEvidenceSchema,
  airQualityQualityStatusSchema,
  airQualitySourceRefSchema,
  airQualitySpatialSupportSchema,
  airQualityStandardIdSchema,
  airQualityUnitSchema,
  type PollutantSeries,
  type PollutantWindowSummary,
  type ProviderEvidence,
  pollutantSchema,
  registerBuiltinStandardAdapters,
  resolveStandard,
  type StandardMode,
} from "@openmapx/air-quality";
import { indexId } from "@openmapx/air-quality/ids";
import { z } from "zod";

const instantSchema = z.iso.datetime({ offset: true });
const observationIdSchema = z.string().regex(/^obs_1_[A-Za-z0-9_-]{43}$/);
const indexIdSchema = z.string().regex(/^idx_1_[A-Za-z0-9_-]{43}$/);

const sampleSchema = z
  .object({
    startAt: instantSchema,
    endAt: instantSchema,
    value: z.number().finite().nonnegative(),
    unit: airQualityUnitSchema,
    valid: z.boolean(),
    estimated: z.boolean(),
    gapFilled: z.boolean(),
  })
  .strict();

const seriesSchema = z
  .object({
    seriesId: z.string().min(1).max(256),
    coherenceKey: z.string().min(1).max(512),
    pollutant: pollutantSchema,
    sensorId: z.string().min(1).max(256).nullable(),
    spatialSupportId: z.string().min(1).max(512),
    cadenceMinutes: z.number().int().positive().max(43_200).nullable(),
    originalUnit: z.string().min(1).max(128),
    samples: z.array(sampleSchema).min(1).max(2_000),
  })
  .strict();

const publishedIndexSchema = z
  .object({
    indexId: indexIdSchema,
    methodId: z.string().min(1).max(512),
    methodRevision: z.string().min(1).max(512),
    claimedStandardId: airQualityStandardIdSchema.nullable(),
    value: z.number().finite().nullable(),
    displayValue: z.string().max(128),
    categoryId: z.string().min(1).max(512),
    dominantPollutants: z.array(pollutantSchema).max(8),
  })
  .strict();

const providerEvidenceSchema: z.ZodType<ProviderEvidence> = z
  .object({
    observationId: observationIdSchema,
    providerId: z.string().min(1).max(128),
    sourceIds: z.array(z.string().min(1).max(128)).min(1).max(32),
    dataAuthority: airQualityAuthoritySchema,
    qualityStatus: airQualityQualityStatusSchema,
    basis: airQualityBasisSchema,
    originRecords: z
      .array(
        z
          .object({
            sourceId: z.string().min(1).max(128),
            recordId: z.string().min(1).max(512),
          })
          .strict(),
      )
      .min(1)
      .max(128),
    modelRunId: z.string().min(1).max(512).nullable(),
    verticalLevel: z.string().min(1).max(128).nullable(),
    series: z.array(seriesSchema).max(64),
    publishedIndices: z.array(publishedIndexSchema).max(32),
    observedAt: instantSchema.nullable(),
    forecastFor: instantSchema.nullable(),
    publishedAt: instantSchema.nullable(),
    validUntil: instantSchema.nullable(),
    spatial: airQualitySpatialSupportSchema,
    sources: z.array(airQualitySourceRefSchema).min(1).max(32),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.series.length === 0 && value.publishedIndices.length === 0)
      context.addIssue({
        code: "custom",
        path: ["series"],
        message: "Evidence needs pollutant series or a published index",
      });
  });

export class ProviderNormalizationError extends Error {
  readonly reason: AirQualityRejectionReason;

  constructor(message: string, reason: AirQualityRejectionReason = "invalid_schema") {
    super(message);
    this.name = "ProviderNormalizationError";
    this.reason = reason;
  }
}

export interface NormalizationOptions {
  targetAt: string;
  mode: StandardMode;
  localStandardId: AirQualityStandardId | null;
  comparisonStandardId: AirQualityStandardId | null;
  subdivisionCode?: string | null;
}

export interface CalculationRejection {
  standardId: AirQualityStandardId;
  reason: AirQualityRejectionReason;
  missingRequirements: string[];
}

function validateSemantics(input: ProviderEvidence): void {
  const sourceIds = new Set(input.sourceIds);
  const describedSources = new Set(input.sources.map(({ sourceId }) => sourceId));
  if (sourceIds.size !== input.sourceIds.length)
    throw new ProviderNormalizationError("Provider evidence sourceIds must be unique");
  for (const sourceId of sourceIds) {
    if (!describedSources.has(sourceId))
      throw new ProviderNormalizationError(`Missing source attribution for ${sourceId}`);
  }
  for (const source of input.sources) {
    if (!sourceIds.has(source.sourceId))
      throw new ProviderNormalizationError(`Unreferenced source attribution ${source.sourceId}`);
  }
  for (const record of input.originRecords) {
    if (!sourceIds.has(record.sourceId))
      throw new ProviderNormalizationError(`Origin record uses unknown source ${record.sourceId}`);
  }
  if (input.series[0] && input.spatial.id !== input.series[0].spatialSupportId)
    throw new ProviderNormalizationError(
      "Evidence spatial support does not match pollutant series",
    );
  for (const series of input.series) {
    if (series.spatialSupportId !== input.spatial.id)
      throw new ProviderNormalizationError("Pollutant series mix spatial supports");
    for (const sample of series.samples) {
      if (Date.parse(sample.startAt) >= Date.parse(sample.endAt))
        throw new ProviderNormalizationError("Pollutant sample interval is empty", "invalid_time");
    }
  }
  const anchor = input.forecastFor ?? input.observedAt ?? input.publishedAt;
  if (anchor === null)
    throw new ProviderNormalizationError(
      "Evidence needs an observation or forecast instant",
      "invalid_time",
    );
  if (input.validUntil !== null && Date.parse(input.validUntil) < Date.parse(anchor))
    throw new ProviderNormalizationError(
      "Evidence validity ends before its anchor",
      "invalid_time",
    );
}

function freshness(input: ProviderEvidence, targetAt: string): AirQualityEvidence["freshness"] {
  const target = Date.parse(targetAt);
  const validUntil = input.validUntil === null ? null : Date.parse(input.validUntil);
  if (validUntil !== null) return validUntil >= target ? "fresh" : "stale";
  const anchorText = input.forecastFor ?? input.observedAt ?? input.publishedAt;
  if (anchorText === null) return "unknown";
  const cadence = Math.min(
    ...input.series
      .map(({ cadenceMinutes }) => cadenceMinutes)
      .filter((value): value is number => value !== null),
  );
  const allowanceMinutes = Number.isFinite(cadence)
    ? cadence <= 15
      ? 60
      : cadence >= 1_440
        ? 1_800
        : Math.max(180, cadence * 2)
    : 180;
  return target - Date.parse(anchorText) <= allowanceMinutes * 60_000 ? "fresh" : "stale";
}

function latestPollutantSummary(
  series: PollutantSeries,
  targetAt: string,
): PollutantWindowSummary | null {
  const target = Date.parse(targetAt);
  const samples = series.samples
    .filter(
      (sample) =>
        sample.valid &&
        Date.parse(sample.startAt) <= target &&
        (Date.parse(sample.endAt) <= target ||
          (Date.parse(sample.startAt) <= target && Date.parse(sample.endAt) > target)),
    )
    .sort((left, right) => Date.parse(right.endAt) - Date.parse(left.endAt));
  const sample = samples[0];
  if (!sample) return null;
  const averagingPeriodMinutes = Math.round(
    (Date.parse(sample.endAt) - Date.parse(sample.startAt)) / 60_000,
  );
  return {
    pollutant: series.pollutant,
    value: sample.value,
    unit: sample.unit,
    originalValue: sample.value,
    originalUnit: series.originalUnit,
    averagingPeriodMinutes: averagingPeriodMinutes > 0 ? averagingPeriodMinutes : null,
    intervalStart: sample.startAt,
    intervalEnd: sample.endAt,
    sampleCount: 1,
    expectedSampleCount: 1,
    completenessPercent: 100,
    gapFilled: sample.gapFilled,
    estimated: sample.estimated,
    sensorId: series.sensorId,
  };
}

function stationType(
  stationClass: ProviderEvidence["spatial"]["stationClass"],
): "traffic" | "background" | "industrial" | "unknown" {
  // Station class alone does not prove the EEA assessment type. Unknown is the
  // truthful conservative input until a provider supplies that classification.
  void stationClass;
  return "unknown";
}

function calculatedIndex(
  input: ProviderEvidence,
  options: NormalizationOptions,
  standardId: AirQualityStandardId,
): {
  index: AirQualityIndex | null;
  rejection: CalculationRejection | null;
  completeness: { passes: boolean; missingRequirements: string[] };
} {
  const resolved = resolveStandard(standardId, options.targetAt);
  if (!resolved.ok || !resolved.adapter.supportedModes.has(options.mode)) {
    const missingRequirements = [
      `${standardId} is unavailable for ${options.mode} at ${options.targetAt}`,
    ];
    return {
      index: null,
      rejection: { standardId, reason: "invalid_time", missingRequirements },
      completeness: { passes: false, missingRequirements },
    };
  }
  const calculationInput = {
    observationId: input.observationId,
    outputIndexId: indexId({
      observationId: input.observationId,
      methodId: resolved.adapter.methodId,
      methodRevision: resolved.adapter.revision,
      standardId: resolved.adapter.standardId,
      standardRevision: resolved.adapter.revision,
    }),
    evaluatedAt: options.targetAt,
    mode: options.mode,
    series: input.series,
    stationType: stationType(input.spatial.stationClass),
  } as const;
  const completeness = resolved.adapter.summarizeCompleteness(calculationInput);
  if (!resolved.adapter.calculate) {
    return {
      index: null,
      rejection: {
        standardId,
        reason: "missing_required_pollutant",
        missingRequirements: completeness.missingRequirements,
      },
      completeness,
    };
  }
  const result = resolved.adapter.calculate(calculationInput);
  if (!result.ok) {
    return {
      index: null,
      rejection: {
        standardId,
        reason: result.reason,
        missingRequirements: result.missingRequirements,
      },
      completeness,
    };
  }
  return {
    index: {
      ...result.index,
      qualityStatus: input.qualityStatus,
      basis: input.basis,
      inputObservationIds: [input.observationId],
    },
    rejection: null,
    completeness,
  };
}

function publishedIndices(
  input: ProviderEvidence,
  options: NormalizationOptions,
): AirQualityIndex[] {
  return input.publishedIndices.flatMap((published): AirQualityIndex[] => {
    if (published.claimedStandardId === null) {
      return [
        {
          indexId: published.indexId,
          standardId: null,
          standardRevision: null,
          methodId: published.methodId,
          methodRevision: published.methodRevision,
          effectiveDate: null,
          value: published.value,
          displayValue: published.displayValue,
          categoryId: published.categoryId,
          dominantPollutants: published.dominantPollutants,
          authority: input.dataAuthority,
          qualityStatus: input.qualityStatus,
          basis: input.basis,
          derivation: "published-index",
          inputObservationIds: [input.observationId],
        },
      ];
    }
    const resolved = resolveStandard(published.claimedStandardId, options.targetAt);
    if (!resolved.ok || !resolved.adapter.validatePublished) return [];
    const result = resolved.adapter.validatePublished(published, {
      spatial: input.spatial,
      observedAt: input.observedAt,
      forecastFor: input.forecastFor,
      publishedAt: input.publishedAt,
      validUntil: input.validUntil,
      subdivisionCode: options.subdivisionCode ?? null,
    });
    if (!result.ok) return [];
    return [
      {
        ...result.index,
        indexId: published.indexId,
        inputObservationIds: [input.observationId],
      },
    ];
  });
}

export function normalizeProviderEvidence(
  value: unknown,
  options: NormalizationOptions,
): { evidence: AirQualityEvidence; calculationRejections: CalculationRejection[] } {
  if (!Number.isFinite(Date.parse(options.targetAt)))
    throw new ProviderNormalizationError("Normalization target must be an instant", "invalid_time");
  const parsed = providerEvidenceSchema.safeParse(value);
  if (!parsed.success)
    throw new ProviderNormalizationError(`Invalid provider evidence: ${parsed.error.message}`);
  const input = parsed.data;
  validateSemantics(input);
  registerBuiltinStandardAdapters();

  const indices = publishedIndices(input, options);
  const completenessByStandard: AirQualityEvidence["completenessByStandard"] = {};
  const calculationRejections: CalculationRejection[] = [];
  const standards = [options.localStandardId, options.comparisonStandardId].filter(
    (standardId, position, all): standardId is AirQualityStandardId =>
      standardId !== null && all.indexOf(standardId) === position,
  );
  for (const standardId of standards) {
    if (indices.some((item) => item.standardId === standardId)) {
      completenessByStandard[standardId] = { passes: true, missingRequirements: [] };
      continue;
    }
    const calculated = calculatedIndex(input, options, standardId);
    completenessByStandard[standardId] = {
      passes: calculated.completeness.passes,
      missingRequirements: calculated.completeness.missingRequirements,
    };
    if (calculated.index) indices.push(calculated.index);
    if (calculated.rejection) calculationRejections.push(calculated.rejection);
  }

  const evidenceFreshness = freshness(input, options.targetAt);
  const evidence: AirQualityEvidence = {
    observationId: input.observationId,
    providerId: input.providerId,
    sourceIds: [...input.sourceIds].sort(),
    dataAuthority: input.dataAuthority,
    qualityStatus: input.qualityStatus,
    basis: input.basis,
    indices: indices.sort(
      (left, right) =>
        (left.standardId ?? "~").localeCompare(right.standardId ?? "~") ||
        left.indexId.localeCompare(right.indexId),
    ),
    pollutants: input.series
      .map((series) => latestPollutantSummary(series, options.targetAt))
      .filter((summary): summary is PollutantWindowSummary => summary !== null)
      .sort((left, right) => left.pollutant.localeCompare(right.pollutant)),
    observedAt: input.observedAt,
    forecastFor: input.forecastFor,
    publishedAt: input.publishedAt,
    validUntil: input.validUntil,
    freshness: evidenceFreshness,
    spatial: input.spatial,
    completenessByStandard,
    sources: [...input.sources].sort((left, right) => left.sourceId.localeCompare(right.sourceId)),
    warnings: evidenceFreshness === "stale" ? ["stale_evidence"] : [],
  };
  const canonical = airQualityEvidenceSchema.safeParse(evidence);
  if (!canonical.success)
    throw new ProviderNormalizationError(`Invalid normalized evidence: ${canonical.error.message}`);
  return { evidence: canonical.data, calculationRejections };
}

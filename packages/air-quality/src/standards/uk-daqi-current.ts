import manifestData from "../data/standards/uk-daqi-2026-04-13.json";
import type { PollutantSeries, PublishedIndexInput } from "../types";
import type {
  CategoryDefinition,
  PublishedValidationContext,
  StandardAdapter,
  StandardCalculationInput,
  StandardCalculationResult,
  StandardSourceManifest,
} from "./adapter";
import {
  arithmeticMean,
  computedIndex,
  rejectIncoherentCalculation,
  rejectIncoherentCompleteness,
} from "./common";

function validatePublished(
  input: PublishedIndexInput,
  context: PublishedValidationContext,
): StandardCalculationResult {
  const observedAt = context.observedAt === null ? Number.NaN : Date.parse(context.observedAt);
  const publishedAt = context.publishedAt === null ? Number.NaN : Date.parse(context.publishedAt);
  const validUntil = context.validUntil === null ? Number.NaN : Date.parse(context.validUntil);
  const expectedCategory =
    Number.isInteger(input.value) && input.value !== null && input.value >= 1 && input.value <= 10
      ? DAQI_CATEGORIES[input.value - 1]?.id
      : null;
  const schemaValid =
    input.methodId === "uk-daqi" &&
    input.methodRevision.trim().length > 0 &&
    input.claimedStandardId === "uk-daqi-current" &&
    expectedCategory !== null &&
    input.categoryId === expectedCategory &&
    input.displayValue === String(input.value) &&
    input.dominantPollutants.length === 0 &&
    context.spatial.kind === "station" &&
    context.spatial.coordinates !== null &&
    context.spatial.mobile === false &&
    context.forecastFor === null;
  if (!schemaValid)
    return {
      ok: false,
      reason: "unverified_method",
      missingRequirements: [
        "Published UK-AIR DAQI value, category, or station contract is inconsistent",
      ],
    };
  if (
    !Number.isFinite(observedAt) ||
    !Number.isFinite(publishedAt) ||
    !Number.isFinite(validUntil) ||
    observedAt > publishedAt ||
    publishedAt >= validUntil
  )
    return {
      ok: false,
      reason: "invalid_time",
      missingRequirements: ["UK-AIR observation, publication, and validity times are inconsistent"],
    };
  return {
    ok: true,
    index: {
      indexId: input.indexId,
      standardId: "uk-daqi-current",
      standardRevision: "uk-daqi-2026-04-13",
      methodId: "uk-daqi",
      methodRevision: input.methodRevision,
      effectiveDate: "2026-04-13",
      value: input.value,
      displayValue: input.displayValue,
      categoryId: input.categoryId,
      dominantPollutants: [],
      authority: "official-agency",
      qualityStatus: "preliminary",
      basis: "ground",
      derivation: "published-index",
      inputObservationIds: [],
    },
  };
}

export type DaqiPollutant = "pm25" | "pm10" | "no2" | "o3" | "so2";

export const DAQI_CATEGORIES: readonly CategoryDefinition[] = [
  { id: "low-1", labelKey: "airQuality.ukDaqi.level1", minimum: 1, maximum: 1, color: "#9cff9c" },
  { id: "low-2", labelKey: "airQuality.ukDaqi.level2", minimum: 2, maximum: 2, color: "#31ff00" },
  { id: "low-3", labelKey: "airQuality.ukDaqi.level3", minimum: 3, maximum: 3, color: "#31cf00" },
  {
    id: "moderate-4",
    labelKey: "airQuality.ukDaqi.level4",
    minimum: 4,
    maximum: 4,
    color: "#ffff00",
  },
  {
    id: "moderate-5",
    labelKey: "airQuality.ukDaqi.level5",
    minimum: 5,
    maximum: 5,
    color: "#ffcf00",
  },
  {
    id: "moderate-6",
    labelKey: "airQuality.ukDaqi.level6",
    minimum: 6,
    maximum: 6,
    color: "#ff9a00",
  },
  { id: "high-7", labelKey: "airQuality.ukDaqi.level7", minimum: 7, maximum: 7, color: "#ff6464" },
  { id: "high-8", labelKey: "airQuality.ukDaqi.level8", minimum: 8, maximum: 8, color: "#ff0000" },
  { id: "high-9", labelKey: "airQuality.ukDaqi.level9", minimum: 9, maximum: 9, color: "#990000" },
  {
    id: "very-high-10",
    labelKey: "airQuality.ukDaqi.level10",
    minimum: 10,
    maximum: null,
    color: "#ce30ff",
  },
];

const bounds = manifestData.transcription.upperBoundsUgM3;
const windows = manifestData.transcription.windowMinutes;

export function calculateDaqiLevel(
  pollutant: DaqiPollutant,
  unroundedValueUgM3: number,
): number | null {
  if (!Number.isFinite(unroundedValueUgM3) || unroundedValueUgM3 < 0) return null;
  const rounded = Math.round(unroundedValueUgM3);
  const index = bounds[pollutant].findIndex((upper) => upper === null || rounded <= upper);
  return index < 0 ? null : index + 1;
}

function requiredSamples(series: PollutantSeries): number {
  const duration = windows[series.pollutant as DaqiPollutant];
  const cadence = series.cadenceMinutes;
  if (!Number.isInteger(cadence) || cadence === null || cadence <= 0)
    return Number.POSITIVE_INFINITY;
  return Math.ceil((duration / cadence) * 0.75);
}

function windowMean(series: PollutantSeries, endAt: string): number | null {
  if (!(series.pollutant in windows)) return null;
  const duration = windows[series.pollutant as DaqiPollutant];
  const cadence = series.cadenceMinutes;
  if (!Number.isInteger(cadence) || cadence === null || cadence <= 0) return null;
  const end = Date.parse(endAt);
  if (!Number.isFinite(end)) return null;
  const start = end - duration * 60_000;
  const cadenceMilliseconds = cadence * 60_000;
  const slots = new Map<number, number[]>();
  for (const sample of series.samples) {
    const sampleStart = Date.parse(sample.startAt);
    const sampleEnd = Date.parse(sample.endAt);
    if (
      !sample.valid ||
      sample.unit !== "ug/m3" ||
      !Number.isFinite(sample.value) ||
      sample.value < 0 ||
      sampleStart < start ||
      sampleEnd > end ||
      sampleEnd - sampleStart !== cadenceMilliseconds ||
      (sampleStart - start) % cadenceMilliseconds !== 0
    )
      continue;
    const values = slots.get(sampleStart) ?? [];
    values.push(sample.value);
    slots.set(sampleStart, values);
  }
  const samples = [...slots]
    .sort(([left], [right]) => left - right)
    .flatMap(([, values]) => (new Set(values).size === 1 ? [values[0] as number] : []));
  if (samples.length < requiredSamples(series)) return null;
  return arithmeticMean(samples);
}

function calculate(input: StandardCalculationInput): StandardCalculationResult {
  const incoherent = rejectIncoherentCalculation(input);
  if (incoherent) return incoherent;
  const levels = input.series.flatMap((series) => {
    const mean = windowMean(series, input.evaluatedAt);
    if (mean === null) return [];
    const level = calculateDaqiLevel(series.pollutant as DaqiPollutant, mean);
    return level === null ? [] : [{ pollutant: series.pollutant, level }];
  });
  if (levels.length === 0)
    return {
      ok: false,
      reason: "incomplete_window",
      missingRequirements: ["No complete DAQI pollutant window"],
    };
  const value = Math.max(...levels.map(({ level }) => level));
  return {
    ok: true,
    index: computedIndex(input, {
      standardId: "uk-daqi-current",
      standardRevision: "uk-daqi-2026-04-13",
      methodId: "uk-daqi",
      methodRevision: "2026-04-13",
      effectiveDate: "2026-04-13",
      value,
      categoryId: DAQI_CATEGORIES[value - 1]?.id ?? "very-high-10",
      dominantPollutants: levels
        .filter(({ level }) => level === value)
        .map(({ pollutant }) => pollutant)
        .sort(),
    }),
  };
}

export const ukDaqiCurrentAdapter: StandardAdapter = {
  standardId: "uk-daqi-current",
  methodId: "uk-daqi",
  revision: "uk-daqi-2026-04-13",
  effectiveFrom: "2026-04-13T00:00:00Z",
  effectiveUntil: null,
  supportedModes: new Set(["current", "history", "forecast"]),
  categories: DAQI_CATEGORIES,
  sourceManifest: manifestData as StandardSourceManifest,
  validatePublished,
  calculate,
  summarizeCompleteness(input) {
    const incoherent = rejectIncoherentCompleteness(input);
    if (incoherent) return incoherent;
    const qualifyingPollutants = input.series
      .filter((series) => windowMean(series, input.evaluatedAt) !== null)
      .map(({ pollutant }) => pollutant);
    return {
      passes: qualifyingPollutants.length > 0,
      missingRequirements:
        qualifyingPollutants.length > 0 ? [] : ["No complete DAQI pollutant window"],
      qualifyingPollutants,
    };
  },
};

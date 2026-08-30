import { validateCoherentSeries } from "../normalize/coherence";
import type { AirQualityIndex, AirQualityQualityStatus, Pollutant } from "../types";
import type {
  CategoryDefinition,
  CompletenessSummary,
  StandardCalculationInput,
  StandardCalculationResult,
} from "./adapter";

export const EPA_CATEGORIES: readonly CategoryDefinition[] = [
  { id: "good", labelKey: "airQuality.category.good", minimum: 0, maximum: 50, color: "#00e400" },
  {
    id: "moderate",
    labelKey: "airQuality.category.moderate",
    minimum: 51,
    maximum: 100,
    color: "#ffff00",
  },
  {
    id: "unhealthy-sensitive",
    labelKey: "airQuality.category.unhealthySensitive",
    minimum: 101,
    maximum: 150,
    color: "#ff7e00",
  },
  {
    id: "unhealthy",
    labelKey: "airQuality.category.unhealthy",
    minimum: 151,
    maximum: 200,
    color: "#ff0000",
  },
  {
    id: "very-unhealthy",
    labelKey: "airQuality.category.veryUnhealthy",
    minimum: 201,
    maximum: 300,
    color: "#8f3f97",
  },
  {
    id: "hazardous",
    labelKey: "airQuality.category.hazardous",
    minimum: 301,
    maximum: null,
    color: "#7e0023",
  },
];

export function categoryForNumericValue(
  value: number,
  categories: readonly CategoryDefinition[],
): string {
  return (
    categories.find(
      ({ minimum, maximum }) => value >= minimum && (maximum === null || value <= maximum),
    )?.id ??
    categories.at(-1)?.id ??
    "unknown"
  );
}

export function computedIndex(
  input: StandardCalculationInput,
  fields: {
    standardId: AirQualityIndex["standardId"];
    standardRevision: string;
    methodId: string;
    methodRevision: string;
    effectiveDate: string;
    value: number;
    categoryId: string;
    dominantPollutants: Pollutant[];
    qualityStatus?: AirQualityQualityStatus;
    basis?: AirQualityIndex["basis"];
  },
): AirQualityIndex {
  return {
    indexId: input.outputIndexId,
    standardId: fields.standardId,
    standardRevision: fields.standardRevision,
    methodId: fields.methodId,
    methodRevision: fields.methodRevision,
    effectiveDate: fields.effectiveDate,
    value: fields.value,
    displayValue: String(fields.value),
    categoryId: fields.categoryId,
    dominantPollutants: fields.dominantPollutants,
    authority: "openmapx",
    qualityStatus: fields.qualityStatus ?? "unknown",
    basis: fields.basis ?? "ground",
    derivation: "openmapx-computed-index",
    inputObservationIds: [input.observationId],
  };
}

export function arithmeticMean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function rejectIncoherentCalculation(
  input: StandardCalculationInput,
): StandardCalculationResult | null {
  if (input.series.length < 2 || validateCoherentSeries(input.series).coherent) return null;
  return {
    ok: false,
    reason: "incoherent_series",
    missingRequirements: [
      "Pollutant series must share one spatial and temporal coherence identity",
    ],
  };
}

export function rejectIncoherentCompleteness(
  input: StandardCalculationInput,
): CompletenessSummary | null {
  if (input.series.length < 2 || validateCoherentSeries(input.series).coherent) return null;
  return {
    passes: false,
    missingRequirements: [
      "Pollutant series must share one spatial and temporal coherence identity",
    ],
    qualifyingPollutants: [],
  };
}

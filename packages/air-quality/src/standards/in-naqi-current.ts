import manifestData from "../data/standards/cpcb-naqi-2014.json";
import type { AirQualityUnit, Pollutant, PollutantSeries } from "../types";
import type {
  CategoryDefinition,
  StandardAdapter,
  StandardCalculationInput,
  StandardCalculationResult,
  StandardSourceManifest,
} from "./adapter";
import { type BreakpointBand, interpolateBreakpoint } from "./breakpoint";
import {
  arithmeticMean,
  categoryForNumericValue,
  computedIndex,
  rejectIncoherentCalculation,
  rejectIncoherentCompleteness,
} from "./common";

export type NaqiPollutant = "pm10" | "pm25" | "no2" | "o3" | "co" | "so2" | "nh3";

export const NAQI_CATEGORIES: readonly CategoryDefinition[] = [
  { id: "good", labelKey: "airQuality.category.good", minimum: 0, maximum: 50, color: "#00b050" },
  {
    id: "satisfactory",
    labelKey: "airQuality.category.satisfactory",
    minimum: 51,
    maximum: 100,
    color: "#92d050",
  },
  {
    id: "moderate",
    labelKey: "airQuality.category.moderate",
    minimum: 101,
    maximum: 200,
    color: "#ffff00",
  },
  {
    id: "poor",
    labelKey: "airQuality.category.poor",
    minimum: 201,
    maximum: 300,
    color: "#ff9900",
  },
  {
    id: "very-poor",
    labelKey: "airQuality.category.veryPoor",
    minimum: 301,
    maximum: 400,
    color: "#ff0000",
  },
  {
    id: "severe",
    labelKey: "airQuality.category.severe",
    minimum: 401,
    maximum: null,
    color: "#c00000",
  },
];

const pollutantBands = manifestData.transcription.concentrationBands;
const indexBands = manifestData.transcription.indexBands;
const severeOpenEndedAbove = manifestData.transcription.severeOpenEndedAbove;

function bandsFor(pollutant: NaqiPollutant): BreakpointBand[] {
  return pollutantBands[pollutant].map(([concentrationLow, concentrationHigh], index) => ({
    concentrationLow,
    concentrationHigh,
    indexLow: indexBands[index]?.[0] ?? 401,
    indexHigh: indexBands[index]?.[1] ?? 500,
  }));
}

export function calculateNaqiSubIndex(
  pollutant: NaqiPollutant,
  concentration: number,
): number | null {
  if (
    !Number.isFinite(concentration) ||
    concentration < 0 ||
    concentration > severeOpenEndedAbove[pollutant]
  )
    return null;
  const bands = bandsFor(pollutant);
  const value = interpolateBreakpoint(concentration, bands);
  return value === null ? null : Math.min(400, Math.max(0, value));
}

function expectedUnit(pollutant: Pollutant): AirQualityUnit {
  return pollutant === "co" ? "mg/m3" : "ug/m3";
}

function valuesInAlignedWindow(
  series: PollutantSeries,
  end: number,
  durationMinutes: number,
): number[] | null {
  const cadence = series.cadenceMinutes;
  if (!Number.isInteger(cadence) || cadence === null || cadence <= 0) return null;
  const cadenceMilliseconds = cadence * 60_000;
  const start = end - durationMinutes * 60_000;
  const slots = new Map<number, number[]>();
  for (const sample of series.samples) {
    const sampleStart = Date.parse(sample.startAt);
    const sampleEnd = Date.parse(sample.endAt);
    if (
      !sample.valid ||
      sample.unit !== expectedUnit(series.pollutant) ||
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
  return [...slots]
    .sort(([left], [right]) => left - right)
    .flatMap(([, values]) => (values.length === 1 ? values : []));
}

function seriesConcentration(series: PollutantSeries, endAt: string): number | null {
  if (!(series.pollutant in pollutantBands)) return null;
  const end = Date.parse(endAt);
  if (!Number.isFinite(end)) return null;
  const cadence = series.cadenceMinutes;
  if (!Number.isInteger(cadence) || cadence === null || cadence <= 0) return null;
  const dailyValues = valuesInAlignedWindow(series, end, 1_440);
  if (dailyValues === null || dailyValues.length * cadence < 16 * 60) return null;
  const windowHours = series.pollutant === "co" || series.pollutant === "o3" ? 8 : 24;
  const window = valuesInAlignedWindow(series, end, windowHours * 60);
  if (window === null || window.length * cadence < windowHours * 40) return null;
  return arithmeticMean(window);
}

function calculate(input: StandardCalculationInput): StandardCalculationResult {
  const incoherent = rejectIncoherentCalculation(input);
  if (incoherent) return incoherent;
  const concentrations = input.series.flatMap((series) => {
    const concentration = seriesConcentration(series, input.evaluatedAt);
    return concentration === null || !(series.pollutant in severeOpenEndedAbove)
      ? []
      : [{ pollutant: series.pollutant as NaqiPollutant, concentration }];
  });
  if (
    concentrations.some(
      ({ pollutant, concentration }) => concentration > severeOpenEndedAbove[pollutant],
    )
  )
    return {
      ok: false,
      reason: "unverified_method",
      missingRequirements: [
        "CPCB publishes open-ended Severe concentration bands without exact upper interpolation breakpoints",
      ],
    };
  if (
    concentrations.some(
      ({ pollutant, concentration }) => calculateNaqiSubIndex(pollutant, concentration) === null,
    )
  )
    return {
      ok: false,
      reason: "unverified_method",
      missingRequirements: [
        "CPCB does not state a concentration-rounding rule for gaps between integer-labelled bands",
      ],
    };
  const subIndices = concentrations.flatMap(({ pollutant, concentration }) => {
    const value = calculateNaqiSubIndex(pollutant, concentration);
    return value === null ? [] : [{ pollutant, value }];
  });
  const pollutants = new Set(subIndices.map(({ pollutant }) => pollutant));
  if (pollutants.size < 3 || (!pollutants.has("pm25") && !pollutants.has("pm10"))) {
    return {
      ok: false,
      reason: "missing_required_pollutant",
      missingRequirements: ["CPCB requires at least three pollutants including PM2.5 or PM10"],
    };
  }
  const value = Math.max(...subIndices.map((item) => item.value));
  return {
    ok: true,
    index: computedIndex(input, {
      standardId: "in-naqi-current",
      standardRevision: "cpcb-naqi-2014",
      methodId: "in-naqi",
      methodRevision: "2014",
      effectiveDate: "2014-10-17",
      value,
      categoryId: categoryForNumericValue(value, NAQI_CATEGORIES),
      dominantPollutants: subIndices
        .filter((item) => item.value === value)
        .map(({ pollutant }) => pollutant)
        .sort(),
    }),
  };
}

export const inNaqiCurrentAdapter: StandardAdapter = {
  standardId: "in-naqi-current",
  methodId: "in-naqi",
  revision: "cpcb-naqi-2014",
  effectiveFrom: "2014-10-17T00:00:00Z",
  effectiveUntil: null,
  supportedModes: new Set(["current", "history", "forecast"]),
  categories: NAQI_CATEGORIES,
  sourceManifest: manifestData as StandardSourceManifest,
  calculate,
  summarizeCompleteness(input) {
    const incoherent = rejectIncoherentCompleteness(input);
    if (incoherent) return incoherent;
    const result = calculate(input);
    if (!result.ok && result.reason === "unverified_method")
      return {
        passes: false,
        missingRequirements: result.missingRequirements,
        qualifyingPollutants: [],
      };
    const qualifyingPollutants = input.series
      .filter((series) => seriesConcentration(series, input.evaluatedAt) !== null)
      .map(({ pollutant }) => pollutant);
    const unique = new Set(qualifyingPollutants);
    const passes = unique.size >= 3 && (unique.has("pm25") || unique.has("pm10"));
    return {
      passes,
      missingRequirements: passes
        ? []
        : ["CPCB requires at least three pollutants including PM2.5 or PM10"],
      qualifyingPollutants,
    };
  },
};

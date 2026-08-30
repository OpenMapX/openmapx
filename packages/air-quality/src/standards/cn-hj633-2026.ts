import manifestData from "../data/standards/hj633-2026.json";
import type { AirQualityUnit, Pollutant, PollutantSeries } from "../types";
import type {
  CategoryDefinition,
  StandardAdapter,
  StandardCalculationInput,
  StandardCalculationResult,
  StandardSourceManifest,
} from "./adapter";
import { truncateTo } from "./breakpoint";
import { computedIndex, rejectIncoherentCalculation, rejectIncoherentCompleteness } from "./common";

export type HjPollutant = "so2" | "no2" | "co" | "o3" | "pm10" | "pm25";
export type HjMode = "daily" | "realtime";

export const HJ633_CATEGORIES: readonly CategoryDefinition[] = [
  {
    id: "excellent",
    labelKey: "airQuality.cn.category.excellent",
    minimum: 0,
    maximum: 50,
    color: "#00e400",
  },
  {
    id: "good",
    labelKey: "airQuality.cn.category.good",
    minimum: 51,
    maximum: 100,
    color: "#ffff00",
  },
  {
    id: "lightly-polluted",
    labelKey: "airQuality.cn.category.lightlyPolluted",
    minimum: 101,
    maximum: 150,
    color: "#ff7e00",
  },
  {
    id: "moderately-polluted",
    labelKey: "airQuality.cn.category.moderatelyPolluted",
    minimum: 151,
    maximum: 200,
    color: "#ff0000",
  },
  {
    id: "heavily-polluted",
    labelKey: "airQuality.cn.category.heavilyPolluted",
    minimum: 201,
    maximum: 300,
    color: "#99004c",
  },
  {
    id: "severely-polluted",
    labelKey: "airQuality.cn.category.severelyPolluted",
    minimum: 301,
    maximum: null,
    color: "#7e0023",
  },
];

const tables = {
  daily: manifestData.transcription.daily,
  realtime: manifestData.transcription.realtime,
};
const iaqi = manifestData.transcription.iaqi;

export function calculateHjSubIndex(
  pollutant: HjPollutant,
  concentration: number,
  mode: HjMode,
): number | null {
  if (!Number.isFinite(concentration) || concentration < 0) return null;
  const normalized = truncateTo(concentration, pollutant === "co" ? 1 : 0);
  if (mode === "realtime" && pollutant === "so2" && normalized > 800) return 200;
  if (mode === "daily" && pollutant === "o3" && normalized > 800) return 300;
  const breakpoints = tables[mode][pollutant];
  for (let index = 0; index < breakpoints.length - 1; index += 1) {
    const low = breakpoints[index];
    const high = breakpoints[index + 1];
    if (low === null || high === null) continue;
    if (normalized >= low && normalized <= high) {
      const indexLow = iaqi[index];
      const indexHigh = iaqi[index + 1];
      if (indexLow === undefined || indexHigh === undefined) continue;
      const interpolated = ((indexHigh - indexLow) / (high - low)) * (normalized - low) + indexLow;
      return Math.min(500, Math.ceil(interpolated));
    }
  }
  const last = [...breakpoints].reverse().find((value): value is number => value !== null);
  return last !== undefined && normalized > last ? 500 : null;
}

function expectedUnit(pollutant: Pollutant): AirQualityUnit {
  return pollutant === "co" ? "mg/m3" : "ug/m3";
}

function latestCompleteInterval(
  series: PollutantSeries,
  evaluatedAt: string,
  durationMinutes: number,
): number | null {
  const end = Date.parse(evaluatedAt);
  if (!Number.isFinite(end)) return null;
  const duration = durationMinutes * 60_000;
  const samples = series.samples
    .filter((sample) => {
      const sampleStart = Date.parse(sample.startAt);
      const sampleEnd = Date.parse(sample.endAt);
      return (
        sample.valid &&
        sample.unit === expectedUnit(series.pollutant) &&
        Number.isFinite(sample.value) &&
        sample.value >= 0 &&
        sampleEnd - sampleStart === duration &&
        sampleEnd <= end &&
        end - sampleEnd <= duration
      );
    })
    .sort((left, right) => right.endAt.localeCompare(left.endAt));
  if (samples.length === 0) return null;
  const latestEnd = samples[0]?.endAt;
  const latest = samples.filter(({ endAt }) => endAt === latestEnd);
  return latest.length === 1 ? (latest[0]?.value ?? null) : null;
}

function concentrationForMode(
  series: PollutantSeries,
  evaluatedAt: string,
  mode: HjMode,
): number | null {
  const duration = mode === "realtime" ? 60 : series.pollutant === "o3" ? 480 : 1_440;
  return latestCompleteInterval(series, evaluatedAt, duration);
}

function calculationMode(input: StandardCalculationInput): HjMode {
  if (input.mode === "current") return "realtime";
  const hasDailyEvidence = input.series.some(
    (series) =>
      series.pollutant in tables.daily &&
      concentrationForMode(series, input.evaluatedAt, "daily") !== null,
  );
  return hasDailyEvidence ? "daily" : "realtime";
}

function calculate(input: StandardCalculationInput): StandardCalculationResult {
  if (Date.parse(input.evaluatedAt) < Date.parse("2026-03-01T00:00:00+08:00")) {
    return {
      ok: false,
      reason: "wrong_standard",
      missingRequirements: ["HJ 633-2026 is effective from 2026-03-01 in China"],
    };
  }
  const incoherent = rejectIncoherentCalculation(input);
  if (incoherent) return incoherent;
  const mode = calculationMode(input);
  const subIndices = input.series.flatMap((series) => {
    if (!(series.pollutant in tables[mode])) return [];
    const concentration = concentrationForMode(series, input.evaluatedAt, mode);
    const value =
      concentration === null
        ? null
        : calculateHjSubIndex(series.pollutant as HjPollutant, concentration, mode);
    return value === null ? [] : [{ pollutant: series.pollutant, value }];
  });
  if (subIndices.length === 0)
    return {
      ok: false,
      reason: "incomplete_window",
      missingRequirements: [
        mode === "daily"
          ? "No complete HJ 633-2026 daily pollutant value"
          : "No complete HJ 633-2026 one-hour pollutant value",
      ],
    };
  const value = Math.max(...subIndices.map(({ value }) => value));
  return {
    ok: true,
    index: computedIndex(input, {
      standardId: "cn-hj633-2026",
      standardRevision: "hj633-2026",
      methodId: mode === "daily" ? "cn-hj633-daily-aqi" : "cn-hj633-realtime-aqi",
      methodRevision: "2026",
      effectiveDate: "2026-03-01",
      value,
      categoryId:
        HJ633_CATEGORIES.find(
          ({ minimum, maximum }) => value >= minimum && (maximum === null || value <= maximum),
        )?.id ?? "severely-polluted",
      dominantPollutants: subIndices
        .filter((item) => item.value === value)
        .map(({ pollutant }) => pollutant)
        .sort(),
    }),
  };
}

export const cnHj6332026Adapter: StandardAdapter = {
  standardId: "cn-hj633-2026",
  methodId: "cn-hj633",
  revision: "hj633-2026",
  effectiveFrom: "2026-02-28T16:00:00Z",
  effectiveUntil: null,
  supportedModes: new Set(["current", "history", "forecast"]),
  categories: HJ633_CATEGORIES,
  sourceManifest: manifestData as StandardSourceManifest,
  calculate,
  summarizeCompleteness(input) {
    const incoherent = rejectIncoherentCompleteness(input);
    if (incoherent) return incoherent;
    const mode = calculationMode(input);
    const qualifyingPollutants = input.series
      .filter((series) => concentrationForMode(series, input.evaluatedAt, mode) !== null)
      .map(({ pollutant }) => pollutant);
    return {
      passes: qualifyingPollutants.length > 0,
      missingRequirements:
        qualifyingPollutants.length > 0
          ? []
          : [
              mode === "daily"
                ? "No complete HJ 633-2026 daily pollutant value"
                : "No complete HJ 633-2026 one-hour pollutant value",
            ],
      qualifyingPollutants,
    };
  },
};

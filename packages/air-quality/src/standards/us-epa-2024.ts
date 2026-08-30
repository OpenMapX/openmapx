import manifestData from "../data/standards/epa-aqi-tad-2024-05.json";
import type { Pollutant, PollutantSeries } from "../types";
import type {
  StandardAdapter,
  StandardCalculationInput,
  StandardCalculationResult,
  StandardSourceManifest,
} from "./adapter";
import { type BreakpointBand, interpolateBreakpoint, truncateTo } from "./breakpoint";
import {
  arithmeticMean,
  categoryForNumericValue,
  computedIndex,
  EPA_CATEGORIES,
  rejectIncoherentCalculation,
  rejectIncoherentCompleteness,
} from "./common";

type EpaWindow = 60 | 480 | 1440;
type EpaBandKey = keyof typeof manifestData.transcription.bands;

function bands(key: EpaBandKey): BreakpointBand[] {
  return manifestData.transcription.bands[key].map(
    ([concentrationLow, concentrationHigh, indexLow, indexHigh]) => ({
      concentrationLow,
      concentrationHigh,
      indexLow,
      indexHigh,
    }),
  );
}

export const EPA_BREAKPOINTS: Readonly<Record<EpaBandKey, readonly BreakpointBand[]>> = {
  "o3-8h": bands("o3-8h"),
  "o3-1h": bands("o3-1h"),
  "pm25-24h": bands("pm25-24h"),
  "pm10-24h": bands("pm10-24h"),
  "co-8h": bands("co-8h"),
  "so2-1h": bands("so2-1h"),
  "so2-24h": bands("so2-24h"),
  "no2-1h": bands("no2-1h"),
};

const precision: Record<Pollutant, number> = {
  o3: 3,
  pm25: 1,
  pm10: 0,
  co: 1,
  so2: 0,
  no2: 0,
  nh3: 0,
  no: 0,
};

function breakpointKey(pollutant: Pollutant, windowMinutes: EpaWindow): EpaBandKey | null {
  if (pollutant === "o3" && windowMinutes === 480) return "o3-8h";
  if (pollutant === "o3" && windowMinutes === 60) return "o3-1h";
  if (pollutant === "pm25" && windowMinutes === 1440) return "pm25-24h";
  if (pollutant === "pm10" && windowMinutes === 1440) return "pm10-24h";
  if (pollutant === "co" && windowMinutes === 480) return "co-8h";
  if (pollutant === "so2" && windowMinutes === 60) return "so2-1h";
  if (pollutant === "so2" && windowMinutes === 1440) return "so2-24h";
  if (pollutant === "no2" && windowMinutes === 60) return "no2-1h";
  return null;
}

export function calculateEpaSubIndex(
  pollutant: Pollutant,
  concentration: number,
  windowMinutes: EpaWindow,
): number | null {
  const key = breakpointKey(pollutant, windowMinutes);
  if (key === null || !Number.isFinite(concentration) || concentration < 0) return null;
  const truncated = truncateTo(concentration, precision[pollutant]);
  const value = interpolateBreakpoint(truncated, EPA_BREAKPOINTS[key]);
  if (value !== null) return Math.min(500, Math.max(0, value));
  const last = EPA_BREAKPOINTS[key].at(-1);
  const canClampAbove = key !== "o3-8h" && key !== "so2-1h";
  return canClampAbove && last && truncated > last.concentrationHigh ? 500 : null;
}

export function calculatePmNowCast(valuesNewestFirst: readonly (number | null)[]): number | null {
  const recent = valuesNewestFirst.slice(0, 12);
  if (
    recent.length < 3 ||
    recent.slice(0, 3).filter((value) => value !== null && Number.isFinite(value) && value >= 0)
      .length < 2
  )
    return null;
  const valid = recent.flatMap((value, hoursAgo) =>
    value !== null && Number.isFinite(value) && value >= 0 ? [{ value, hoursAgo }] : [],
  );
  if (valid.length === 0) return null;
  const concentrations = valid.map(({ value }) => value);
  const maximum = Math.max(...concentrations);
  const minimum = Math.min(...concentrations);
  const weight = maximum === 0 ? 1 : Math.max(0.5, 1 - (maximum - minimum) / maximum);
  let numerator = 0;
  let denominator = 0;
  for (const item of valid) {
    const factor = weight ** item.hoursAgo;
    numerator += item.value * factor;
    denominator += factor;
  }
  return numerator / denominator;
}

function hourlySlotsNewestFirst(
  series: PollutantSeries,
  evaluatedAt: string,
  count: number,
  unit: string,
): (number | null)[] {
  if (series.cadenceMinutes !== 60) return Array(count).fill(null);
  const evaluated = Date.parse(evaluatedAt);
  if (!Number.isFinite(evaluated)) return Array(count).fill(null);

  const temporal = series.samples.flatMap((sample) => {
    const start = Date.parse(sample.startAt);
    const end = Date.parse(sample.endAt);
    return Number.isFinite(start) &&
      Number.isFinite(end) &&
      end - start === 3_600_000 &&
      end <= evaluated
      ? [{ sample, end }]
      : [];
  });
  const anchor = Math.max(...temporal.map(({ end }) => end));
  if (!Number.isFinite(anchor) || evaluated - anchor > 3_600_000) return Array(count).fill(null);

  return Array.from({ length: count }, (_, hoursAgo) => {
    const expectedEnd = anchor - hoursAgo * 3_600_000;
    const matches = temporal.filter(({ end }) => end === expectedEnd);
    if (matches.length !== 1) return null;
    const { sample } = matches[0] as (typeof matches)[number];
    return sample.valid &&
      sample.unit === unit &&
      Number.isFinite(sample.value) &&
      sample.value >= 0
      ? sample.value
      : null;
  });
}

function hourlyWindowMean(
  series: PollutantSeries,
  endAt: string,
  hours: number,
  unit: string,
): number | null {
  const values = hourlySlotsNewestFirst(series, endAt, hours, unit);
  if (values.some((value) => value === null)) return null;
  return arithmeticMean(values as number[]);
}

function dailyMaximumRollingMean(
  series: PollutantSeries,
  endAt: string,
  hours: number,
  unit: string,
): number | null {
  const values = hourlySlotsNewestFirst(series, endAt, 24 + hours - 1, unit);
  if (values.some((value) => value === null)) return null;
  const numeric = values as number[];
  return Math.max(
    ...Array.from({ length: 24 }, (_, endOffset) =>
      arithmeticMean(numeric.slice(endOffset, endOffset + hours)),
    ).filter((value): value is number => value !== null),
  );
}

function calculate(input: StandardCalculationInput): StandardCalculationResult {
  const incoherent = rejectIncoherentCalculation(input);
  if (incoherent) return incoherent;
  const subIndices: { pollutant: Pollutant; value: number }[] = [];
  for (const series of input.series) {
    const candidates: { concentration: number | null; window: EpaWindow }[] = [];
    if ((series.pollutant === "pm25" || series.pollutant === "pm10") && input.mode === "current") {
      candidates.push({
        concentration: calculatePmNowCast(
          hourlySlotsNewestFirst(series, input.evaluatedAt, 12, "ug/m3"),
        ),
        window: 1440,
      });
    } else if (series.pollutant === "pm25" || series.pollutant === "pm10") {
      candidates.push({
        concentration: hourlyWindowMean(series, input.evaluatedAt, 24, "ug/m3"),
        window: 1440,
      });
    } else if (series.pollutant === "o3") {
      candidates.push(
        {
          concentration:
            input.mode === "current"
              ? hourlyWindowMean(series, input.evaluatedAt, 8, "ppm")
              : dailyMaximumRollingMean(series, input.evaluatedAt, 8, "ppm"),
          window: 480,
        },
        {
          concentration:
            input.mode === "current"
              ? hourlyWindowMean(series, input.evaluatedAt, 1, "ppm")
              : dailyMaximumRollingMean(series, input.evaluatedAt, 1, "ppm"),
          window: 60,
        },
      );
    } else if (series.pollutant === "co") {
      candidates.push({
        concentration:
          input.mode === "current"
            ? hourlyWindowMean(series, input.evaluatedAt, 8, "ppm")
            : dailyMaximumRollingMean(series, input.evaluatedAt, 8, "ppm"),
        window: 480,
      });
    } else if (series.pollutant === "no2") {
      candidates.push({
        concentration:
          input.mode === "current"
            ? hourlyWindowMean(series, input.evaluatedAt, 1, "ppb")
            : dailyMaximumRollingMean(series, input.evaluatedAt, 1, "ppb"),
        window: 60,
      });
    } else if (series.pollutant === "so2") {
      candidates.push(
        {
          concentration:
            input.mode === "current"
              ? hourlyWindowMean(series, input.evaluatedAt, 1, "ppb")
              : dailyMaximumRollingMean(series, input.evaluatedAt, 1, "ppb"),
          window: 60,
        },
        {
          concentration: hourlyWindowMean(series, input.evaluatedAt, 24, "ppb"),
          window: 1440,
        },
      );
    }

    for (const { concentration, window } of candidates) {
      if (concentration === null) continue;
      const value = calculateEpaSubIndex(series.pollutant, concentration, window);
      if (value !== null) subIndices.push({ pollutant: series.pollutant, value });
    }
  }
  if (subIndices.length === 0)
    return {
      ok: false,
      reason: "incomplete_window",
      missingRequirements: ["No complete EPA pollutant window"],
    };
  const value = Math.max(...subIndices.map((item) => item.value));
  return {
    ok: true,
    index: computedIndex(input, {
      standardId: "us-epa-2024",
      standardRevision: "epa-aqi-tad-2024-05",
      methodId: input.mode === "current" ? "epa-nowcast-aqi" : "epa-daily-aqi",
      methodRevision: "2024-05",
      effectiveDate: "2024-05-06",
      value,
      categoryId: categoryForNumericValue(value, EPA_CATEGORIES),
      dominantPollutants: subIndices
        .filter((item) => item.value === value)
        .map((item) => item.pollutant)
        .filter((pollutant, index, all) => all.indexOf(pollutant) === index)
        .sort(),
    }),
  };
}

export const usEpa2024Adapter: StandardAdapter = {
  standardId: "us-epa-2024",
  methodId: "epa-aqi",
  revision: "epa-aqi-tad-2024-05",
  effectiveFrom: "2024-05-06T00:00:00Z",
  effectiveUntil: null,
  supportedModes: new Set(["current", "history", "forecast"]),
  categories: EPA_CATEGORIES,
  sourceManifest: manifestData as StandardSourceManifest,
  calculate,
  summarizeCompleteness(input) {
    const incoherent = rejectIncoherentCompleteness(input);
    if (incoherent) return incoherent;
    const result = calculate(input);
    return result.ok
      ? {
          passes: true,
          missingRequirements: [],
          qualifyingPollutants: result.index.dominantPollutants,
        }
      : {
          passes: false,
          missingRequirements: result.missingRequirements,
          qualifyingPollutants: [],
        };
  },
};

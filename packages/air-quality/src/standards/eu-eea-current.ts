import manifestData from "../data/standards/eea-eaqi-2026-08-29.json";
import type {
  CategoryDefinition,
  StandardAdapter,
  StandardCalculationInput,
  StandardCalculationResult,
  StandardSourceManifest,
} from "./adapter";
import { computedIndex, rejectIncoherentCalculation, rejectIncoherentCompleteness } from "./common";

export type EeaPollutant = "pm25" | "pm10" | "o3" | "no2" | "so2";
export type EeaStationType = "traffic" | "background" | "industrial" | "unknown";

export const EEA_CATEGORIES: readonly CategoryDefinition[] = [
  {
    id: "good",
    labelKey: "airQuality.category.good",
    minimum: 1,
    maximum: 1,
    color: "#50f0e6",
    rasterValue: 1,
  },
  {
    id: "fair",
    labelKey: "airQuality.category.fair",
    minimum: 2,
    maximum: 2,
    color: "#50ccaa",
    rasterValue: 2,
  },
  {
    id: "moderate",
    labelKey: "airQuality.category.moderate",
    minimum: 3,
    maximum: 3,
    color: "#f0e641",
    rasterValue: 3,
  },
  {
    id: "poor",
    labelKey: "airQuality.category.poor",
    minimum: 4,
    maximum: 4,
    color: "#ff5050",
    rasterValue: 4,
  },
  {
    id: "very-poor",
    labelKey: "airQuality.category.veryPoor",
    minimum: 5,
    maximum: 5,
    color: "#960032",
    rasterValue: 5,
  },
  {
    id: "extremely-poor",
    labelKey: "airQuality.category.extremelyPoor",
    minimum: 6,
    maximum: null,
    color: "#7d2181",
    rasterValue: 6,
  },
];

const bounds = manifestData.transcription.upperBoundsUgM3;

export function classifyEeaPollutant(pollutant: EeaPollutant, valueUgM3: number): number | null {
  if (!Number.isFinite(valueUgM3) || valueUgM3 < 0) return null;
  const index = bounds[pollutant].findIndex((upper) => upper === null || valueUgM3 <= upper);
  return index < 0 ? null : index + 1;
}

export interface EeaPollutantInput {
  pollutant: EeaPollutant;
  valueUgM3: number;
  gapFilled?: boolean;
}

export interface EeaIndexResult {
  level: number;
  categoryId: string;
  dominantPollutants: EeaPollutant[];
  qualified: boolean;
  partialAlert: boolean;
  basis: "ground" | "hybrid";
}

function requiredPollutantsPresent(
  inputs: readonly EeaPollutantInput[],
  stationType: EeaStationType,
): boolean {
  const pollutants = new Set(inputs.map(({ pollutant }) => pollutant));
  const hasPm = pollutants.has("pm25") || pollutants.has("pm10");
  if (stationType === "traffic") return pollutants.has("no2") && hasPm;
  return pollutants.has("no2") && pollutants.has("o3") && hasPm;
}

export function calculateEeaIndex(
  inputs: readonly EeaPollutantInput[],
  stationType: EeaStationType,
): EeaIndexResult | null {
  const usable = inputs.filter((input) => !(input.pollutant === "so2" && input.gapFilled));
  const subIndices = usable.flatMap((input) => {
    const level = classifyEeaPollutant(input.pollutant, input.valueUgM3);
    return level === null ? [] : [{ ...input, level }];
  });
  if (subIndices.length === 0) return null;
  const level = Math.max(...subIndices.map((item) => item.level));
  const qualified = requiredPollutantsPresent(usable, stationType);
  if (!qualified && level < 4) return null;
  return {
    level,
    categoryId: EEA_CATEGORIES[level - 1]?.id ?? "extremely-poor",
    dominantPollutants: subIndices
      .filter((item) => item.level === level)
      .map(({ pollutant }) => pollutant)
      .sort(),
    qualified,
    partialAlert: !qualified,
    basis: usable.some(({ gapFilled }) => gapFilled) ? "hybrid" : "ground",
  };
}

function latestInputs(input: StandardCalculationInput): EeaPollutantInput[] {
  return input.series.flatMap((series) => {
    if (!(series.pollutant in bounds) || series.cadenceMinutes !== 60) return [];
    const evaluated = Date.parse(input.evaluatedAt);
    const eligible = series.samples
      .filter((sample) => {
        const start = Date.parse(sample.startAt);
        const end = Date.parse(sample.endAt);
        return (
          sample.valid &&
          sample.unit === "ug/m3" &&
          Number.isFinite(sample.value) &&
          sample.value >= 0 &&
          end - start === 3_600_000 &&
          end <= evaluated &&
          evaluated - end <= 3_600_000
        );
      })
      .sort((left, right) => right.endAt.localeCompare(left.endAt));
    const latestEnd = eligible[0]?.endAt;
    const latest = eligible.filter(({ endAt }) => endAt === latestEnd);
    if (latest.length !== 1) return [];
    const sample = latest[0];
    if (!sample) return [];
    return [
      {
        pollutant: series.pollutant as EeaPollutant,
        valueUgM3: sample.value,
        gapFilled: sample.gapFilled,
      },
    ];
  });
}

function calculate(input: StandardCalculationInput): StandardCalculationResult {
  const incoherent = rejectIncoherentCalculation(input);
  if (incoherent) return incoherent;
  const result = calculateEeaIndex(latestInputs(input), input.stationType ?? "unknown");
  if (!result)
    return {
      ok: false,
      reason: "missing_required_pollutant",
      missingRequirements: ["EEA station-type pollutant qualification not met"],
    };
  return {
    ok: true,
    index: computedIndex(input, {
      standardId: "eu-eea-current",
      standardRevision: "eea-eaqi-2026-08-29",
      methodId: "eea-european-aqi",
      methodRevision: "2026-08-29",
      effectiveDate: "2025-07-01",
      value: result.level,
      categoryId: result.categoryId,
      dominantPollutants: result.dominantPollutants,
      basis: result.basis,
    }),
  };
}

export const euEeaCurrentAdapter: StandardAdapter = {
  standardId: "eu-eea-current",
  methodId: "eea-european-aqi",
  revision: "eea-eaqi-2026-08-29",
  effectiveFrom: "2025-07-01T00:00:00Z",
  effectiveUntil: null,
  supportedModes: new Set(["current", "history", "forecast"]),
  categories: EEA_CATEGORIES,
  sourceManifest: manifestData as StandardSourceManifest,
  calculate,
  summarizeCompleteness(input) {
    const incoherent = rejectIncoherentCompleteness(input);
    if (incoherent) return incoherent;
    const available = latestInputs(input);
    const passes = requiredPollutantsPresent(available, input.stationType ?? "unknown");
    return {
      passes,
      missingRequirements: passes ? [] : ["EEA station-type pollutant qualification not met"],
      qualifyingPollutants: available.map(({ pollutant }) => pollutant),
    };
  },
};

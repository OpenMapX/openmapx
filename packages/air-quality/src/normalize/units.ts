import type { AirQualityUnit, PollutantSample } from "../types";

export type InvalidSampleReason =
  | "non_finite"
  | "negative"
  | "invalid_interval"
  | "unsupported_unit";

export interface NormalizedPollutantSample extends PollutantSample {
  originalValue: number;
  originalUnit: string;
  invalidReason: InvalidSampleReason | null;
}

const UNIT_DIMENSION: Record<AirQualityUnit, "mass" | "volume"> = {
  "ug/m3": "mass",
  "mg/m3": "mass",
  ppb: "volume",
  ppm: "volume",
};

function conversionFactor(from: AirQualityUnit, to: AirQualityUnit): number | null {
  if (from === to) return 1;
  if (UNIT_DIMENSION[from] !== UNIT_DIMENSION[to]) return null;
  if (from === "mg/m3" && to === "ug/m3") return 1_000;
  if (from === "ug/m3" && to === "mg/m3") return 1 / 1_000;
  if (from === "ppm" && to === "ppb") return 1_000;
  if (from === "ppb" && to === "ppm") return 1 / 1_000;
  return null;
}

export function convertConcentration(
  value: number,
  from: AirQualityUnit,
  to: AirQualityUnit,
): number | null {
  if (!Number.isFinite(value) || value < 0) return null;
  const factor = conversionFactor(from, to);
  return factor === null ? null : value * factor;
}

export function normalizeSample(
  sample: PollutantSample,
  targetUnit: AirQualityUnit,
): NormalizedPollutantSample {
  const originalValue = sample.value;
  const originalUnit = sample.unit;
  let invalidReason: InvalidSampleReason | null = null;
  if (!Number.isFinite(sample.value)) invalidReason = "non_finite";
  else if (sample.value < 0) invalidReason = "negative";
  else if (
    !Number.isFinite(Date.parse(sample.startAt)) ||
    !Number.isFinite(Date.parse(sample.endAt)) ||
    Date.parse(sample.startAt) >= Date.parse(sample.endAt)
  ) {
    invalidReason = "invalid_interval";
  }
  const converted =
    invalidReason === null ? convertConcentration(sample.value, sample.unit, targetUnit) : null;
  if (invalidReason === null && converted === null) invalidReason = "unsupported_unit";
  return {
    ...sample,
    value: converted ?? sample.value,
    unit: converted === null ? sample.unit : targetUnit,
    valid: sample.valid && invalidReason === null,
    originalValue,
    originalUnit,
    invalidReason,
  };
}

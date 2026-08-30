import type { AirQualityUnit, PollutantSample } from "../types";
import { type NormalizedPollutantSample, normalizeSample } from "./units";

export function normalizeSamples(
  samples: readonly PollutantSample[],
  targetUnit: AirQualityUnit,
): NormalizedPollutantSample[] {
  return samples
    .map((sample) => normalizeSample(sample, targetUnit))
    .sort(
      (left, right) =>
        left.startAt.localeCompare(right.startAt) || left.endAt.localeCompare(right.endAt),
    );
}

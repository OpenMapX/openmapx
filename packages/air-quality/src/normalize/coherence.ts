import type { AirQualityBasis, PollutantSeries } from "../types";

export type CoherenceIdentity =
  | {
      basis: "ground";
      providerId: string;
      providerLocationId: string;
      spatialSupportId: string;
    }
  | {
      basis: "model" | "hybrid";
      providerId: string;
      modelRunId: string;
      gridCellId: string;
      verticalLevel: string;
      spatialSupportId: string;
    }
  | {
      basis: AirQualityBasis;
      providerId: string;
      aggregateId: string;
      spatialSupportId: string;
    };

function encodePart(value: string): string {
  return `${new TextEncoder().encode(value).length}:${value}`;
}

export function deriveCoherenceKey(identity: CoherenceIdentity): string {
  const ordered = Object.entries(identity).sort(([left], [right]) => left.localeCompare(right));
  return `aqc1:${ordered.map(([key, value]) => `${encodePart(key)}${encodePart(value)}`).join("")}`;
}

export interface CoherenceValidation {
  coherent: boolean;
  reason: "incoherent_series" | null;
  endSkewMinutes: number;
}

export function validateCoherentSeries(
  series: readonly PollutantSeries[],
  maximumEndSkewMinutes = 60,
): CoherenceValidation {
  if (!Number.isFinite(maximumEndSkewMinutes) || maximumEndSkewMinutes < 0)
    throw new RangeError("Maximum end skew must be a non-negative finite number of minutes");
  if (series.length === 0)
    return { coherent: false, reason: "incoherent_series", endSkewMinutes: 0 };
  const keys = new Set(series.map((item) => item.coherenceKey));
  const supports = new Set(series.map((item) => item.spatialSupportId));
  const ends = series.map((item) => {
    const validEnds = item.samples
      .filter((sample) => sample.valid)
      .map((sample) => Date.parse(sample.endAt))
      .filter(Number.isFinite);
    return validEnds.length === 0 ? Number.NaN : Math.max(...validEnds);
  });
  if (ends.some((end) => !Number.isFinite(end)))
    return { coherent: false, reason: "incoherent_series", endSkewMinutes: 0 };
  const endSkewMinutes = (Math.max(...ends) - Math.min(...ends)) / 60_000;
  const declaredCadences = series
    .map(({ cadenceMinutes }) => cadenceMinutes)
    .filter(
      (cadence): cadence is number => Number.isFinite(cadence) && cadence !== null && cadence > 0,
    );
  const cadenceLimit =
    declaredCadences.length === series.length ? Math.min(...declaredCadences) : 60;
  const coherent =
    keys.size === 1 &&
    supports.size === 1 &&
    endSkewMinutes <= Math.min(60, maximumEndSkewMinutes, cadenceLimit);
  return { coherent, reason: coherent ? null : "incoherent_series", endSkewMinutes };
}

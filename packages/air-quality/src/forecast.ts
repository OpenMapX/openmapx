import type { AirQualitySelectionResult } from "./selection";
import type { AirQualityBasis, AirQualityEvidence } from "./types";

export interface ForecastSeries {
  seriesId: string;
  providerId: string;
  spatialSupportId: string;
  basis: AirQualityBasis;
  evidenceIds: string[];
}

export interface ForecastFrame {
  frameAt: string;
  evidenceIds: string[];
  selection: AirQualitySelectionResult;
}

export interface ForecastGrouping {
  evidence: AirQualityEvidence[];
  series: ForecastSeries[];
  frames: ForecastFrame[];
}

function stableEvidence(evidence: AirQualityEvidence): string {
  const canonical = (value: unknown): string => {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean" ||
      typeof value === "number"
    )
      return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (typeof value === "object")
      return `{${Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
        .join(",")}}`;
    throw new TypeError("Forecast evidence must be JSON-compatible");
  };
  return canonical(evidence);
}

function encodeSeriesPart(value: string): string {
  return `${new TextEncoder().encode(value).length}:${value}`;
}

export function groupForecastEvidence(input: {
  windowStart: string;
  windowEnd: string;
  evidence: readonly AirQualityEvidence[];
  selectFrame: (
    frameAt: string,
    evidence: readonly AirQualityEvidence[],
  ) => AirQualitySelectionResult;
}): ForecastGrouping {
  const start = Date.parse(input.windowStart);
  const end = Date.parse(input.windowEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end)
    throw new RangeError("Forecast window must be a non-empty interval");
  const byId = new Map<string, AirQualityEvidence>();
  for (const item of input.evidence) {
    const existing = byId.get(item.observationId);
    if (existing && stableEvidence(existing) !== stableEvidence(item))
      throw new TypeError(`Conflicting duplicate forecast evidence: ${item.observationId}`);
    byId.set(item.observationId, item);
  }
  const evidence = [...byId.values()].sort(
    (left, right) =>
      (left.forecastFor ?? "").localeCompare(right.forecastFor ?? "") ||
      left.observationId.localeCompare(right.observationId),
  );
  const frameTimes = new Set<number>([start]);
  for (const item of evidence) {
    const time = Date.parse(item.forecastFor ?? "");
    if (time >= start && time < end) frameTimes.add(time);
  }
  const frames = [...frameTimes]
    .sort((a, b) => a - b)
    .map((frameTime): ForecastFrame => {
      const participating = evidence.filter((item) => {
        const validFrom = Date.parse(item.forecastFor ?? "");
        const validUntil = Date.parse(item.validUntil ?? "");
        return (
          Number.isFinite(validFrom) &&
          validFrom <= frameTime &&
          Number.isFinite(validUntil) &&
          frameTime < validUntil
        );
      });
      const frameAt = new Date(frameTime).toISOString();
      return {
        frameAt,
        evidenceIds: participating.map(({ observationId }) => observationId).sort(),
        selection: input.selectFrame(frameAt, participating),
      };
    });
  const series = new Map<string, ForecastSeries>();
  for (const item of evidence) {
    const seriesId = `aqfs1:${[item.providerId, item.spatial.id, item.basis]
      .map(encodeSeriesPart)
      .join("")}`;
    const entry = series.get(seriesId) ?? {
      seriesId,
      providerId: item.providerId,
      spatialSupportId: item.spatial.id,
      basis: item.basis,
      evidenceIds: [],
    };
    entry.evidenceIds.push(item.observationId);
    series.set(seriesId, entry);
  }
  return {
    evidence,
    series: [...series.values()]
      .map((entry) => ({ ...entry, evidenceIds: [...entry.evidenceIds] }))
      .sort((a, b) => a.seriesId.localeCompare(b.seriesId)),
    frames,
  };
}

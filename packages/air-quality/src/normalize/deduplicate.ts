import type { AirQualitySourceRef, AirQualityUnit, Pollutant } from "../types";
import { convertConcentration } from "./units";

export interface DeduplicationRecord {
  observationId: string;
  sourceId: string;
  originRecordId: string;
  spatialSupportId: string;
  pollutant: Pollutant;
  startAt: string;
  endAt: string;
  value: number;
  unit: AirQualityUnit;
  precision: number;
  sources: AirQualitySourceRef[];
}

export interface DeduplicatedRecord extends DeduplicationRecord {
  observationIds: string[];
}

export interface DeduplicationResult {
  records: DeduplicatedRecord[];
  conflicts: { key: string; observationIds: string[]; reason: "duplicate_conflict" }[];
}

function duplicateKey(record: DeduplicationRecord): string {
  return JSON.stringify([
    record.sourceId,
    record.originRecordId,
    record.spatialSupportId,
    record.pollutant,
    record.startAt,
    record.endAt,
  ]);
}

function mergeSources(records: readonly DeduplicationRecord[]): AirQualitySourceRef[] {
  const merged = new Map<string, AirQualitySourceRef>();
  for (const record of records) {
    for (const source of record.sources) merged.set(source.sourceId, source);
  }
  return [...merged.values()].sort((left, right) => left.sourceId.localeCompare(right.sourceId));
}

function sourceMetadataConflict(records: readonly DeduplicationRecord[]): boolean {
  const seen = new Map<string, string>();
  for (const record of records) {
    for (const source of record.sources) {
      const serialized = JSON.stringify(source, Object.keys(source).sort());
      const existing = seen.get(source.sourceId);
      if (existing !== undefined && existing !== serialized) return true;
      seen.set(source.sourceId, serialized);
    }
  }
  return false;
}

export function deduplicateRecords(input: readonly DeduplicationRecord[]): DeduplicationResult {
  const groups = new Map<string, DeduplicationRecord[]>();
  for (const record of input) {
    const key = duplicateKey(record);
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }
  const records: DeduplicatedRecord[] = [];
  const conflicts: DeduplicationResult["conflicts"] = [];
  for (const [key, group] of [...groups].sort(([left], [right]) => left.localeCompare(right))) {
    const canonical = [...group].sort(
      (left, right) =>
        left.observationId.localeCompare(right.observationId) ||
        left.unit.localeCompare(right.unit) ||
        left.value - right.value ||
        left.precision - right.precision,
    )[0];
    if (!canonical) continue;
    const converted = group.map((record) =>
      convertConcentration(record.value, record.unit, canonical.unit),
    );
    const tolerances = group.map((record) =>
      Number.isInteger(record.precision) && record.precision >= 0 && record.precision <= 12
        ? convertConcentration(0.5 * 10 ** -record.precision, record.unit, canonical.unit)
        : null,
    );
    const tolerance = tolerances.every((value): value is number => value !== null)
      ? Math.max(...tolerances)
      : null;
    const conflict =
      tolerance === null ||
      converted.some((value) => value === null || Math.abs(value - canonical.value) > tolerance) ||
      sourceMetadataConflict(group);
    const observationIds = [...new Set(group.map((record) => record.observationId))].sort();
    if (conflict) {
      conflicts.push({ key, observationIds, reason: "duplicate_conflict" });
      continue;
    }
    records.push({
      ...canonical,
      observationIds,
      sources: mergeSources(group),
    });
  }
  return { records, conflicts };
}

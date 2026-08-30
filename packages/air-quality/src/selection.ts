import type {
  AirQualityEvidence,
  AirQualityIndex,
  AirQualityRejectionReason,
  AirQualitySelectionReason,
  AirQualityStandardId,
  AirQualityWarningCode,
} from "./types";

export interface AirQualitySelectionInput {
  evidence: readonly AirQualityEvidence[];
  localStandardId: AirQualityStandardId | null;
  localStandardRevision: string | null;
  targetAt: string;
  providerPriorities: Readonly<Record<string, number>>;
  allowStale?: boolean;
  additionalWarnings?: readonly AirQualityWarningCode[];
  additionalRejections?: Readonly<Record<string, readonly AirQualityRejectionReason[]>>;
}

export interface AirQualitySelectionRejection {
  evidenceId: string;
  indexId: string | null;
  reasons: AirQualityRejectionReason[];
  missingRequirements: string[];
}

export interface AirQualitySelectionResult {
  primaryEvidenceId: string | null;
  primaryIndexId: string | null;
  rankedIndexIds: string[];
  rankedRawEvidenceIds: string[];
  secondaryEvidenceIds: string[];
  reasons: AirQualitySelectionReason[];
  rejected: AirQualitySelectionRejection[];
  warnings: AirQualityWarningCode[];
}

type IndexClass = "agency" | "computed-ground" | "model";

interface RankedIndex {
  evidence: AirQualityEvidence;
  index: AirQualityIndex;
  indexClass: IndexClass;
  tuple: readonly (number | string)[];
}

const freshnessRank = { fresh: 0, stale: 1, unknown: 2 } as const;
const basisRank = { ground: 0, hybrid: 1, model: 2 } as const;
const stationRank = { reference: 0, regulatory: 1 } as const;

function compareTuple(
  left: readonly (number | string)[],
  right: readonly (number | string)[],
): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === b) continue;
    if (typeof a === "number" && typeof b === "number") return a - b;
    return String(a).localeCompare(String(b));
  }
  return 0;
}

function timestamp(evidence: AirQualityEvidence): number {
  const parsed = Date.parse(
    evidence.forecastFor ?? evidence.observedAt ?? evidence.publishedAt ?? "",
  );
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function distance(evidence: AirQualityEvidence): number {
  const value = evidence.spatial.distanceMeters;
  return value === null || !Number.isFinite(value) ? Number.MAX_SAFE_INTEGER : Math.round(value);
}

function providerPriority(
  evidence: AirQualityEvidence,
  priorities: Readonly<Record<string, number>>,
): number {
  const value = priorities[evidence.providerId];
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

function classifyIndex(index: AirQualityIndex): IndexClass | null {
  if (index.derivation === "published-index" && index.authority === "official-agency")
    return "agency";
  if (
    index.derivation === "openmapx-computed-index" &&
    index.authority === "openmapx" &&
    index.basis === "ground"
  )
    return "computed-ground";
  if (
    (index.basis === "model" || index.basis === "hybrid") &&
    ((index.derivation === "openmapx-computed-index" && index.authority === "openmapx") ||
      (index.derivation === "published-index" &&
        (index.authority === "data-owner" || index.authority === "aggregator")))
  )
    return "model";
  return null;
}

function timeCovers(evidence: AirQualityEvidence, targetAt: string): boolean {
  const target = Date.parse(targetAt);
  if (!Number.isFinite(target)) return false;
  const validFrom = Date.parse(
    evidence.forecastFor ?? evidence.observedAt ?? evidence.publishedAt ?? "",
  );
  if (!Number.isFinite(validFrom) || validFrom > target) return false;
  if (evidence.publishedAt !== null) {
    const published = Date.parse(evidence.publishedAt);
    if (!Number.isFinite(published) || published > target) return false;
  }
  if (evidence.validUntil !== null) {
    const validUntil = Date.parse(evidence.validUntil);
    if (!Number.isFinite(validUntil) || validUntil <= target) return false;
  }
  return true;
}

function indexRejections(
  evidence: AirQualityEvidence,
  index: AirQualityIndex,
  input: AirQualitySelectionInput,
): AirQualityRejectionReason[] {
  const reasons = [...(input.additionalRejections?.[index.indexId] ?? [])];
  if (
    input.localStandardId === null ||
    index.standardId !== input.localStandardId ||
    index.standardRevision !== input.localStandardRevision
  )
    reasons.push("wrong_standard");
  if (index.standardId === null || index.standardRevision === null)
    reasons.push("unverified_method");
  if (
    !index.indexId ||
    !evidence.observationId ||
    !evidence.providerId ||
    evidence.sources.length === 0 ||
    evidence.sourceIds.length === 0 ||
    classifyIndex(index) === null
  )
    reasons.push("invalid_schema");
  if (!timeCovers(evidence, input.targetAt)) reasons.push("invalid_time");
  if (evidence.freshness !== "fresh" && input.allowStale === false) reasons.push("stale");
  const indexClass = classifyIndex(index);
  if (indexClass === "agency" || indexClass === "model") {
    if (!evidence.spatial.coversRequestedPoint) reasons.push("does_not_cover_point");
  }
  if (indexClass === "computed-ground") {
    if (evidence.spatial.mobile !== false) reasons.push("mobile_sensor");
    if (evidence.spatial.stationClass === "low-cost") reasons.push("low_cost_sensor");
    if (
      evidence.spatial.stationClass !== "reference" &&
      evidence.spatial.stationClass !== "regulatory"
    )
      reasons.push("unrecognized_station_class");
    if (evidence.spatial.distanceMeters === null || evidence.spatial.distanceMeters > 50_000)
      reasons.push("outside_primary_radius");
  }
  return [...new Set(reasons)].sort();
}

function indexTuple(
  ranked: Omit<RankedIndex, "tuple">,
  priorities: Readonly<Record<string, number>>,
): readonly (number | string)[] {
  const { evidence, index, indexClass } = ranked;
  return [
    freshnessRank[evidence.freshness],
    { agency: 0, "computed-ground": 1, model: 2 }[indexClass],
    indexClass === "agency" ? basisRank[index.basis] : 0,
    evidence.spatial.coversRequestedPoint ? 0 : 1,
    indexClass === "computed-ground"
      ? (stationRank[evidence.spatial.stationClass as keyof typeof stationRank] ?? 2)
      : 0,
    distance(evidence),
    -timestamp(evidence),
    providerPriority(evidence, priorities),
    index.indexId,
  ];
}

function rawTuple(
  evidence: AirQualityEvidence,
  priorities: Readonly<Record<string, number>>,
): readonly (number | string)[] {
  const rawStationRank =
    evidence.basis !== "ground"
      ? 0
      : evidence.spatial.stationClass === "reference" ||
          evidence.spatial.stationClass === "regulatory"
        ? 0
        : evidence.spatial.stationClass === "indicative"
          ? 1
          : evidence.spatial.stationClass === "low-cost"
            ? 2
            : 3;
  return [
    freshnessRank[evidence.freshness],
    basisRank[evidence.basis],
    rawStationRank,
    evidence.spatial.mobile === true ? 1 : 0,
    distance(evidence),
    providerPriority(evidence, priorities),
    -timestamp(evidence),
    evidence.observationId,
  ];
}

export function selectAirQuality(input: AirQualitySelectionInput): AirQualitySelectionResult {
  const ranked: RankedIndex[] = [];
  const rejected: AirQualitySelectionRejection[] = [];
  for (const evidence of [...input.evidence].sort((a, b) =>
    a.observationId.localeCompare(b.observationId),
  )) {
    for (const index of [...evidence.indices].sort((a, b) => a.indexId.localeCompare(b.indexId))) {
      const reasons = indexRejections(evidence, index, input);
      const indexClass = classifyIndex(index);
      if (reasons.length > 0 || indexClass === null) {
        const completeness =
          input.localStandardId === null
            ? undefined
            : evidence.completenessByStandard[input.localStandardId];
        rejected.push({
          evidenceId: evidence.observationId,
          indexId: index.indexId,
          reasons,
          missingRequirements: completeness?.missingRequirements ?? [],
        });
      } else {
        const candidate = { evidence, index, indexClass };
        ranked.push({ ...candidate, tuple: indexTuple(candidate, input.providerPriorities) });
      }
    }
  }
  ranked.sort((left, right) => compareTuple(left.tuple, right.tuple));
  const raw = [...input.evidence]
    .filter(({ pollutants }) => pollutants.length > 0)
    .sort((left, right) =>
      compareTuple(
        rawTuple(left, input.providerPriorities),
        rawTuple(right, input.providerPriorities),
      ),
    );
  const primary = ranked[0];
  const primaryEvidence = primary?.evidence ?? raw[0] ?? null;
  const reasons: AirQualitySelectionReason[] = primary
    ? [
        "local_standard",
        ...(primary.indexClass === "agency"
          ? ["published_by_agency" as const]
          : primary.indexClass === "computed-ground"
            ? ["openmapx_computed" as const]
            : []),
        primary.indexClass === "computed-ground" ? "qualifying_ground_monitor" : "covers_point",
        ...(primary.evidence.freshness === "fresh" ? ["fresh" as const] : []),
        ...(ranked.length === 1 ? ["only_qualifying_index" as const] : []),
      ]
    : primaryEvidence
      ? ["raw_fallback"]
      : [];
  const warnings = new Set(input.additionalWarnings ?? []);
  if (primaryEvidence?.freshness !== undefined && primaryEvidence.freshness !== "fresh")
    warnings.add("stale_evidence");
  for (const evidence of input.evidence)
    for (const warning of evidence.warnings) warnings.add(warning);
  return {
    primaryEvidenceId: primaryEvidence?.observationId ?? null,
    primaryIndexId: primary?.index.indexId ?? null,
    rankedIndexIds: ranked.map(({ index }) => index.indexId),
    rankedRawEvidenceIds: raw.map(({ observationId }) => observationId),
    secondaryEvidenceIds: input.evidence
      .filter(
        ({ spatial }) =>
          spatial.distanceMeters !== null &&
          spatial.distanceMeters > 50_000 &&
          spatial.distanceMeters <= 100_000,
      )
      .map(({ observationId }) => observationId)
      .sort(),
    reasons,
    rejected: rejected.sort(
      (a, b) =>
        a.evidenceId.localeCompare(b.evidenceId) ||
        (a.indexId ?? "").localeCompare(b.indexId ?? ""),
    ),
    warnings: [...warnings].sort(),
  };
}

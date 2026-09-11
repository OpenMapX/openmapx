import type {
  CapabilityCandidate,
  CapabilityResult,
  CapabilityStatus,
  CoverageDomain,
  CoverageDomainOperationId,
  CoveragePermission,
  CoverageReasonCode,
  EvaluatedCapabilityCandidate,
  RightsAssessmentStatus,
  RightsAssessmentSummary,
  RightsEvidence,
  UsageAssessment,
} from "./types";

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

function statusRank(status: CapabilityStatus): number {
  return { operational: 4, limited: 3, unknown: 2, unavailable: 1 }[status];
}

function rightsForAssessment(
  record: RightsEvidence,
  assessment: Exclude<UsageAssessment, "operational">,
): CoveragePermission {
  if (assessment === "commercial") return record.commercialUse;
  if (assessment === "redistribute-source-data") return record.redistribution.sourceData;
  return record.redistribution.derivedData;
}

export function assessUsageRights(
  records: readonly RightsEvidence[],
  assessment: UsageAssessment,
): RightsAssessmentSummary {
  if (assessment === "operational") {
    return {
      status: "not-applicable",
      reasons: [],
      contributorKeys: records.map((record) => record.key),
      conditions: [],
    };
  }
  if (records.length === 0) {
    return {
      status: "review-required",
      reasons: ["rights_unknown"],
      contributorKeys: [],
      conditions: [],
    };
  }

  const permissions = records.map((record) => rightsForAssessment(record, assessment));
  const reasons: CoverageReasonCode[] = [];
  const conditions = unique(records.flatMap((record) => record.usageConditions));
  const hasConflict = records.some((record) => record.conflict);
  const hasUnknown = records.some(
    (record) => !record.lineageKnown || rightsForAssessment(record, assessment) === "unknown",
  );
  if (hasConflict) reasons.push("rights_conflict");
  if (hasUnknown) reasons.push("rights_unknown");
  if (conditions.length > 0 || permissions.includes("conditional"))
    reasons.push("conditions_apply");
  if (!records.every((record) => record.lineageKnown)) reasons.push("lineage_unknown");

  let status: RightsAssessmentStatus;
  if (permissions.includes("no")) status = "not-permitted";
  else if (hasConflict || hasUnknown) status = "review-required";
  else if (permissions.includes("conditional") || conditions.length > 0)
    status = "conditions-apply";
  else if (permissions.every((permission) => permission === "yes")) status = "permitted";
  else status = "review-required";

  return {
    status,
    reasons: unique(reasons),
    contributorKeys: records.map((record) => record.key),
    conditions,
  };
}

function candidateStatus(candidate: CapabilityCandidate): EvaluatedCapabilityCandidate {
  const reasons = [...candidate.reasons];
  const add = (reason: CoverageReasonCode) => {
    if (!reasons.includes(reason)) reasons.push(reason);
  };

  if (reasons.includes("policy_excluded")) return { ...candidate, status: "unavailable", reasons };
  if (!candidate.enabled) {
    add("not_configured");
    return { ...candidate, status: "unavailable", reasons };
  }
  if (candidate.binding === "missing") {
    add("binding_missing");
    return { ...candidate, status: "unavailable", reasons };
  }
  if (candidate.operationSupported === false) {
    add("operation_unsupported");
    return { ...candidate, status: "unavailable", reasons };
  }
  if (candidate.presence === "not-configured") {
    add("not_configured");
    return { ...candidate, status: "unavailable", reasons };
  }
  if (candidate.regionRelation === "disjoint") {
    add("source_disjoint");
    return { ...candidate, status: "unavailable", reasons };
  }
  if (candidate.runtime === "down" || candidate.runtime === "unconfigured") {
    add(candidate.runtime === "down" ? "runtime_down" : "not_configured");
    return { ...candidate, status: "unavailable", reasons };
  }
  if (["stale", "expired"].includes(candidate.freshness) && !candidate.freshnessUsable) {
    add(candidate.freshness === "expired" ? "live_expired" : "source_partial");
    return { ...candidate, status: "unavailable", reasons };
  }
  if (candidate.binding === "unknown") {
    add("lineage_unknown");
    return { ...candidate, status: "unknown", reasons };
  }
  if (candidate.operationSupported === "unknown") {
    add("operation_unsupported");
    return { ...candidate, status: "unknown", reasons };
  }
  if (candidate.presence === "unknown") {
    add("no_publication_evidence");
    return { ...candidate, status: "unknown", reasons };
  }
  if (
    reasons.some((reason) =>
      ["version_unverified", "lineage_unknown", "schedule_validity_unknown"].includes(reason),
    )
  ) {
    return { ...candidate, status: "unknown", reasons };
  }
  if (candidate.runtime === "unknown") {
    add("health_unobserved");
    return { ...candidate, status: "unknown", reasons };
  }
  if (candidate.freshness === "unknown") {
    add("freshness_policy_missing");
    return { ...candidate, status: "unknown", reasons };
  }

  let limited = reasons.includes("declared_only") || reasons.includes("source_partial");
  if (candidate.regionRelation === "intersects") {
    add("source_partial");
    limited = true;
  }
  if (candidate.regionRelation === "unknown") {
    add("region_unknown");
    return { ...candidate, status: "unknown", reasons };
  }
  if (candidate.runtime === "degraded") {
    add("runtime_degraded");
    limited = true;
  }
  if (
    candidate.freshness === "stale" ||
    (candidate.freshness === "expired" && candidate.freshnessUsable)
  ) {
    add(candidate.freshness === "expired" ? "live_expired" : "source_partial");
    limited = true;
  }
  return { ...candidate, status: limited ? "limited" : "operational", reasons };
}

export function evaluateCapabilityCandidates(input: {
  operationId: CoverageDomainOperationId;
  domain: CoverageDomain;
  candidates: readonly CapabilityCandidate[];
  policyState?: "allowed" | "excluded" | "unknown";
}): CapabilityResult {
  const evaluated = input.candidates.map(candidateStatus);
  const policyState = input.policyState ?? "allowed";
  const ranked = evaluated.reduce<EvaluatedCapabilityCandidate | null>((best, candidate) => {
    if (!best || statusRank(candidate.status) > statusRank(best.status)) return candidate;
    return best;
  }, null);
  const bestStatus = ranked?.status ?? "unknown";
  const reasons = unique(evaluated.flatMap((candidate) => candidate.reasons));
  const optionalReasons = unique(evaluated.flatMap((candidate) => candidate.optionalReasons ?? []));
  if (policyState === "excluded" && !reasons.includes("policy_excluded"))
    reasons.push("policy_excluded");
  // Keep the headline facts attached to the selected candidate. A disabled
  // alternative cannot supply a healthy runtime or a better regional match.
  const geographicQualification = ranked?.regionRelation ?? "unknown";
  const runtime = ranked?.runtime ?? "unknown";
  return {
    operationId: input.operationId,
    domain: input.domain,
    status:
      policyState === "excluded"
        ? "unavailable"
        : policyState === "unknown" && bestStatus !== "unavailable"
          ? "unknown"
          : bestStatus,
    candidates: evaluated,
    evidenceKeys: unique(evaluated.flatMap((candidate) => candidate.requiredEvidenceKeys)),
    geographicQualification,
    runtime,
    policyState,
    reasons,
    optionalReasons,
  };
}

export function summarizeCapabilityResults(
  results: readonly CapabilityResult[],
): Record<CapabilityStatus, number> {
  return {
    operational: results.filter((result) => result.status === "operational").length,
    limited: results.filter((result) => result.status === "limited").length,
    unavailable: results.filter((result) => result.status === "unavailable").length,
    unknown: results.filter((result) => result.status === "unknown").length,
  };
}

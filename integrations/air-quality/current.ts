import {
  type AirQualityCurrentResponse,
  type AirQualityEvidence,
  type AirQualityRejectionReason,
  type AirQualityWarningCode,
  airQualityCurrentResponseSchema,
  registerBuiltinStandardAdapters,
  resolveStandard,
  selectAirQuality,
} from "@openmapx/air-quality";
import type { IntegrationContext, PointAirQualityQuery } from "@openmapx/integration-framework";

import {
  canonicalPointCacheKey,
  readCanonicalPointCache,
  writeCanonicalPointCache,
} from "./cache-policy.js";
import { resolvePointJurisdiction } from "./jurisdiction.js";
import {
  type CalculationRejection,
  normalizeProviderEvidence,
  ProviderNormalizationError,
} from "./normalize.js";
import { createAirQualityOrchestrator } from "./orchestrator.js";
import type { ParsedPointQuery } from "./query.js";

const MAX_RESPONSE_BYTES = 2 * 1_024 * 1_024;
const MAX_CURRENT_EVIDENCE = 32;

export class NormalizedResponseTooLargeError extends Error {
  readonly code = "NORMALIZED_RESPONSE_TOO_LARGE";

  constructor() {
    super("The primary air-quality evidence cannot fit in the normalized response envelope");
    this.name = "NormalizedResponseTooLargeError";
  }
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
    .join(",")}}`;
}

function mergeEquivalent(
  left: AirQualityEvidence,
  right: AirQualityEvidence,
): AirQualityEvidence | null {
  const { sources: _leftSources, sourceIds: _leftIds, ...leftCore } = left;
  const { sources: _rightSources, sourceIds: _rightIds, ...rightCore } = right;
  if (stable(leftCore) !== stable(rightCore)) return null;
  const sources = new Map(left.sources.map((source) => [source.sourceId, source]));
  for (const source of right.sources) {
    const existing = sources.get(source.sourceId);
    if (existing && stable(existing) !== stable(source)) return null;
    sources.set(source.sourceId, source);
  }
  return {
    ...left,
    sourceIds: [...new Set([...left.sourceIds, ...right.sourceIds])].sort(),
    sources: [...sources.values()].sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
  };
}

export function deduplicateCanonicalEvidence(input: readonly AirQualityEvidence[]): {
  evidence: AirQualityEvidence[];
  conflictingIds: string[];
} {
  const byId = new Map<string, AirQualityEvidence>();
  const conflicts = new Set<string>();
  for (const item of input) {
    if (conflicts.has(item.observationId)) continue;
    const prior = byId.get(item.observationId);
    if (!prior) {
      byId.set(item.observationId, item);
      continue;
    }
    const merged = mergeEquivalent(prior, item);
    if (merged) byId.set(item.observationId, merged);
    else {
      byId.delete(item.observationId);
      conflicts.add(item.observationId);
    }
  }
  return {
    evidence: [...byId.values()].sort(
      (left, right) =>
        left.providerId.localeCompare(right.providerId) ||
        left.observationId.localeCompare(right.observationId),
    ),
    conflictingIds: [...conflicts].sort(),
  };
}

function hasEcccCommunityMatch(raw: readonly unknown[]): boolean {
  return raw.some((value) => {
    if (!value || typeof value !== "object") return false;
    const item = value as {
      spatial?: { kind?: unknown };
      sourceIds?: unknown;
      providerId?: unknown;
    };
    const identifiers = [
      ...(Array.isArray(item.sourceIds) ? item.sourceIds : []),
      item.providerId,
    ].map(String);
    return (
      item.spatial?.kind === "community" &&
      identifiers.some((id) => /eccc|environment-canada/i.test(id))
    );
  });
}

function warningsFor(input: {
  jurisdiction: ReturnType<typeof resolvePointJurisdiction>;
  failed: readonly unknown[];
  policyExcluded: readonly string[];
  truncated: boolean;
  conflicts: readonly string[];
  comparisonRequested: boolean;
  comparisonFound: boolean;
}): AirQualityWarningCode[] {
  const warnings = new Set<AirQualityWarningCode>();
  if (
    input.jurisdiction.resolution === "unresolved" ||
    input.jurisdiction.resolution === "ambiguous"
  )
    warnings.add("jurisdiction_unresolved");
  if (input.jurisdiction.requestHintMatched === false) warnings.add("jurisdiction_hint_mismatch");
  if (input.failed.length > 0) warnings.add("partial_providers");
  if (input.policyExcluded.length > 0) warnings.add("policy_excluded");
  if (input.truncated) warnings.add("quota_truncated");
  if (input.conflicts.length > 0) warnings.add("duplicate_conflict");
  if (input.comparisonRequested && !input.comparisonFound) warnings.add("comparison_unavailable");
  return [...warnings].sort();
}

function compactSelection(
  selected: ReturnType<typeof selectAirQuality>,
  calculationRejections: ReadonlyMap<string, readonly CalculationRejection[]>,
  conflicts: readonly string[],
): AirQualityCurrentResponse["selection"] {
  const rejected = [...selected.rejected];
  for (const [evidenceId, failures] of calculationRejections) {
    for (const failure of failures) {
      rejected.push({
        evidenceId,
        indexId: null,
        reasons: [failure.reason],
        missingRequirements: failure.missingRequirements,
      });
    }
  }
  for (const evidenceId of conflicts) {
    rejected.push({
      evidenceId,
      indexId: null,
      reasons: ["duplicate_conflict" as AirQualityRejectionReason],
      missingRequirements: [],
    });
  }
  return {
    reasons: selected.reasons,
    rejected: rejected
      .sort(
        (left, right) =>
          left.evidenceId.localeCompare(right.evidenceId) ||
          (left.indexId ?? "").localeCompare(right.indexId ?? ""),
      )
      .slice(0, 1_024),
  };
}

function responseBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function withCacheState(
  response: AirQualityCurrentResponse,
  cache: "fresh" | "stale",
  extraWarnings: readonly AirQualityWarningCode[] = [],
): AirQualityCurrentResponse {
  const warnings = [...new Set([...response.meta.warnings, ...extraWarnings])].sort();
  return {
    ...response,
    status: response.status === "ok" && extraWarnings.length > 0 ? "partial" : response.status,
    meta: { ...response.meta, cache, warnings },
  };
}

function reselectCachedCurrent(
  cached: AirQualityCurrentResponse,
  query: ParsedPointQuery,
  cache: "fresh" | "stale",
  providerPriorities: Readonly<Record<string, number>>,
): AirQualityCurrentResponse {
  registerBuiltinStandardAdapters();
  const jurisdiction = resolvePointJurisdiction(query, {
    ecccCommunityMatch: hasEcccCommunityMatch(cached.evidence),
  });
  const resolution = jurisdiction.localStandardId
    ? resolveStandard(jurisdiction.localStandardId, query.evaluatedAt)
    : null;
  const target = Date.parse(query.evaluatedAt);
  const evidence = cached.evidence.map((item): AirQualityEvidence => {
    const validUntil = Date.parse(item.validUntil ?? "");
    const anchor = Date.parse(item.forecastFor ?? item.observedAt ?? item.publishedAt ?? "");
    const fresh =
      (Number.isFinite(validUntil) && validUntil > target) ||
      (!Number.isFinite(validUntil) &&
        Number.isFinite(anchor) &&
        target - anchor <= 3 * 60 * 60_000);
    return {
      ...item,
      freshness: fresh ? "fresh" : "stale",
      warnings: fresh
        ? item.warnings.filter((warning) => warning !== "stale_evidence")
        : [...new Set<AirQualityWarningCode>([...item.warnings, "stale_evidence"])].sort(),
    };
  });
  const selected = selectAirQuality({
    evidence,
    localStandardId: jurisdiction.localStandardId,
    localStandardRevision: resolution?.ok ? resolution.resolvedRevision : null,
    targetAt: query.evaluatedAt,
    providerPriorities,
    allowStale: true,
  });
  const warnings = new Set<AirQualityWarningCode>(cached.meta.warnings);
  for (const warning of selected.warnings) warnings.add(warning);
  if (cache === "stale") warnings.add("stale_cache");
  const comparisonIndexIds = query.comparisonStandard
    ? evidence
        .flatMap(({ indices }) => indices)
        .filter(({ standardId }) => standardId === query.comparisonStandard)
        .map(({ indexId }) => indexId)
        .sort()
    : [];
  if (query.comparisonStandard && comparisonIndexIds.length === 0)
    warnings.add("comparison_unavailable");
  const primary = evidence.find(
    ({ observationId }) => observationId === selected.primaryEvidenceId,
  );
  return airQualityCurrentResponseSchema.parse({
    ...cached,
    status:
      evidence.length === 0
        ? "unavailable"
        : cache === "stale" || primary?.freshness !== "fresh" || warnings.size > 0
          ? "partial"
          : "ok",
    jurisdiction,
    primaryEvidenceId: selected.primaryEvidenceId,
    primaryIndexId: selected.primaryIndexId,
    comparisonStandardId: query.comparisonStandard ?? null,
    comparisonIndexIds,
    evidence,
    selection: compactSelection(selected, new Map(), []),
    meta: {
      ...cached.meta,
      generatedAt: new Date().toISOString(),
      cache,
      warnings: [...warnings].sort(),
    },
  });
}

export function createCurrentService(ctx: IntegrationContext) {
  const orchestrator = createAirQualityOrchestrator(ctx);

  return async function current(
    query: ParsedPointQuery,
    signal?: AbortSignal,
  ): Promise<AirQualityCurrentResponse> {
    registerBuiltinStandardAdapters();
    const point: PointAirQualityQuery = {
      latitude: query.latitude,
      longitude: query.longitude,
      evaluatedAt: query.evaluatedAt,
      ...(query.countryCode ? { countryCode: query.countryCode } : {}),
      ...(query.subdivisionCode ? { subdivisionCode: query.subdivisionCode } : {}),
      ...(query.comparisonStandard ? { comparisonStandard: query.comparisonStandard } : {}),
    };
    const initialJurisdiction = resolvePointJurisdiction(query);
    const initialResolution = initialJurisdiction.localStandardId
      ? resolveStandard(initialJurisdiction.localStandardId, query.evaluatedAt)
      : null;
    const preflight = await orchestrator.preflight("current", point);
    const key = canonicalPointCacheKey({
      mode: "current",
      latitude: query.latitude,
      longitude: query.longitude,
      localStandardId: initialJurisdiction.localStandardId,
      localStandardRevision: initialResolution?.ok ? initialResolution.resolvedRevision : null,
      comparisonStandardId: query.comparisonStandard ?? null,
      queryBinding: query.queryHash,
      providersCandidate: preflight.providersCandidate,
      providersPolicyExcluded: preflight.providersPolicyExcluded,
      providerPriorities: preflight.providerPriorities,
    });
    const cached = await readCanonicalPointCache<AirQualityCurrentResponse>(
      ctx.upstreamRuntime,
      key,
    );
    if (
      cached.state === "fresh" &&
      preflight.providersProbe.length === 0 &&
      preflight.providersUnhealthy.length === 0
    ) {
      const parsed = airQualityCurrentResponseSchema.safeParse(cached.value);
      if (parsed.success) {
        const refreshed = reselectCachedCurrent(
          parsed.data,
          query,
          "fresh",
          preflight.providerPriorities,
        );
        const primary = refreshed.evidence.find(
          ({ observationId }) => observationId === refreshed.primaryEvidenceId,
        );
        if (primary?.freshness === "fresh") return refreshed;
      }
    }

    const orchestration = await orchestrator.current(point, signal, preflight);
    const raw = orchestration.results.flatMap(({ evidence }) => evidence);
    const jurisdiction = resolvePointJurisdiction(query, {
      ecccCommunityMatch: hasEcccCommunityMatch(raw),
    });
    const localResolution = jurisdiction.localStandardId
      ? resolveStandard(jurisdiction.localStandardId, query.evaluatedAt)
      : null;
    const priorities = preflight.providerPriorities;
    const normalized: AirQualityEvidence[] = [];
    const calculationRejections = new Map<string, CalculationRejection[]>();
    const normalizationFailures: Array<{
      providerId: string;
      code: "invalid_schema" | "invalid_time";
    }> = [];
    for (const result of orchestration.results) {
      for (const value of result.evidence) {
        try {
          const item = normalizeProviderEvidence(value, {
            targetAt: query.evaluatedAt,
            mode: "current",
            localStandardId: jurisdiction.localStandardId,
            comparisonStandardId: query.comparisonStandard ?? null,
            subdivisionCode: jurisdiction.subdivisionCode,
          });
          normalized.push(item.evidence);
          calculationRejections.set(item.evidence.observationId, item.calculationRejections);
        } catch (error) {
          normalizationFailures.push({
            providerId: result.provider.id,
            code:
              error instanceof ProviderNormalizationError && error.reason === "invalid_time"
                ? "invalid_time"
                : "invalid_schema",
          });
        }
      }
    }
    const deduplicated = deduplicateCanonicalEvidence(normalized);
    let bounded = deduplicated.evidence.slice(0, MAX_CURRENT_EVIDENCE);
    let truncated =
      orchestration.diagnostics.truncated || deduplicated.evidence.length > MAX_CURRENT_EVIDENCE;
    const failed = [...orchestration.diagnostics.providersFailed, ...normalizationFailures].sort(
      (a, b) => a.providerId.localeCompare(b.providerId),
    );

    const build = (evidence: AirQualityEvidence[]): AirQualityCurrentResponse => {
      const selected = selectAirQuality({
        evidence,
        localStandardId: jurisdiction.localStandardId,
        localStandardRevision: localResolution?.ok ? localResolution.resolvedRevision : null,
        targetAt: query.evaluatedAt,
        providerPriorities: priorities,
        allowStale: true,
      });
      const comparisonIndexIds = query.comparisonStandard
        ? evidence
            .flatMap(({ indices }) => indices)
            .filter(({ standardId }) => standardId === query.comparisonStandard)
            .map(({ indexId }) => indexId)
            .sort()
        : [];
      const warnings = warningsFor({
        jurisdiction,
        failed,
        policyExcluded: orchestration.diagnostics.providersPolicyExcluded,
        truncated,
        conflicts: deduplicated.conflictingIds,
        comparisonRequested: query.comparisonStandard !== undefined,
        comparisonFound: comparisonIndexIds.length > 0,
      });
      for (const warning of selected.warnings) warnings.push(warning);
      const uniqueWarnings = [...new Set(warnings)].sort();
      const primary = evidence.find(
        ({ observationId }) => observationId === selected.primaryEvidenceId,
      );
      const degraded =
        failed.length > 0 ||
        orchestration.diagnostics.providersPolicyExcluded.length > 0 ||
        truncated ||
        deduplicated.conflictingIds.length > 0 ||
        primary?.freshness === "stale" ||
        uniqueWarnings.includes("comparison_unavailable");
      return {
        status: evidence.length === 0 ? "unavailable" : degraded ? "partial" : "ok",
        jurisdiction,
        primaryEvidenceId: selected.primaryEvidenceId,
        primaryIndexId: selected.primaryIndexId,
        comparisonStandardId: query.comparisonStandard ?? null,
        comparisonIndexIds,
        evidence,
        selection: compactSelection(selected, calculationRejections, deduplicated.conflictingIds),
        meta: {
          generatedAt: new Date().toISOString(),
          cache: "miss",
          providersCandidate: orchestration.diagnostics.providersCandidate,
          providersServed: orchestration.diagnostics.providersServed,
          providersFailed: failed,
          providersPolicyExcluded: orchestration.diagnostics.providersPolicyExcluded,
          truncated,
          warnings: uniqueWarnings,
        },
      };
    };

    let response = build(bounded);
    while (bounded.length > 1 && responseBytes(response) > MAX_RESPONSE_BYTES) {
      bounded = bounded.slice(0, -1);
      truncated = true;
      response = build(bounded);
    }
    if (responseBytes(response) > MAX_RESPONSE_BYTES) throw new NormalizedResponseTooLargeError();
    const parsed = airQualityCurrentResponseSchema.parse(response);
    const allLiveFailed = raw.length === 0 && failed.length > 0;
    if (allLiveFailed && cached.state !== "miss") {
      const stale = airQualityCurrentResponseSchema.safeParse(cached.value);
      if (stale.success) {
        const cacheState = cached.state === "fresh" ? "fresh" : "stale";
        const refreshed = reselectCachedCurrent(
          stale.data,
          query,
          cacheState,
          preflight.providerPriorities,
        );
        const fallback = withCacheState(refreshed, cacheState, [
          ...(cacheState === "stale" ? (["stale_cache"] as const) : []),
          "partial_providers",
        ]);
        return {
          ...fallback,
          meta: {
            ...fallback.meta,
            providersCandidate: orchestration.diagnostics.providersCandidate,
            providersFailed: failed,
            providersPolicyExcluded: orchestration.diagnostics.providersPolicyExcluded,
          },
        };
      }
    }
    if (parsed.evidence.length > 0)
      await writeCanonicalPointCache(ctx.upstreamRuntime, key, parsed);
    return parsed;
  };
}

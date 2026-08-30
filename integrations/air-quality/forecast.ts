import {
  type AirQualityEvidence,
  type AirQualityForecastResponse,
  type AirQualityWarningCode,
  airQualityForecastResponseSchema,
  groupForecastEvidence,
  registerBuiltinStandardAdapters,
  resolveStandard,
  selectAirQuality,
} from "@openmapx/air-quality";
import type { ForecastAirQualityQuery, IntegrationContext } from "@openmapx/integration-framework";

import {
  canonicalPointCacheKey,
  readCanonicalPointCache,
  writeCanonicalPointCache,
} from "./cache-policy.js";
import { deduplicateCanonicalEvidence, NormalizedResponseTooLargeError } from "./current.js";
import { resolvePointJurisdiction } from "./jurisdiction.js";
import { normalizeProviderEvidence, ProviderNormalizationError } from "./normalize.js";
import { createAirQualityOrchestrator } from "./orchestrator.js";
import type { ParsedPointQuery } from "./query.js";

const MAX_FORECAST_EVIDENCE = 1_024;
const MAX_RESPONSE_BYTES = 2 * 1_024 * 1_024;

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function compact(selected: ReturnType<typeof selectAirQuality>) {
  return { reasons: selected.reasons, rejected: selected.rejected.slice(0, 1_024) };
}

export function createForecastService(ctx: IntegrationContext) {
  const orchestrator = createAirQualityOrchestrator(ctx);

  return async function forecast(
    query: ParsedPointQuery & { hours: number },
    signal?: AbortSignal,
  ): Promise<AirQualityForecastResponse> {
    registerBuiltinStandardAdapters();
    const point: ForecastAirQualityQuery = {
      latitude: query.latitude,
      longitude: query.longitude,
      evaluatedAt: query.evaluatedAt,
      hours: query.hours,
      ...(query.countryCode ? { countryCode: query.countryCode } : {}),
      ...(query.subdivisionCode ? { subdivisionCode: query.subdivisionCode } : {}),
      ...(query.comparisonStandard ? { comparisonStandard: query.comparisonStandard } : {}),
    };
    const jurisdiction = resolvePointJurisdiction(query);
    const initialStandard = jurisdiction.localStandardId
      ? resolveStandard(jurisdiction.localStandardId, query.evaluatedAt)
      : null;
    const preflight = await orchestrator.preflight("forecast", point);
    const key = canonicalPointCacheKey({
      mode: "forecast",
      latitude: query.latitude,
      longitude: query.longitude,
      hours: query.hours,
      localStandardId: jurisdiction.localStandardId,
      localStandardRevision: initialStandard?.ok ? initialStandard.resolvedRevision : null,
      comparisonStandardId: query.comparisonStandard ?? null,
      queryBinding: query.queryHash,
      providersCandidate: preflight.providersCandidate,
      providersPolicyExcluded: preflight.providersPolicyExcluded,
      providerPriorities: preflight.providerPriorities,
    });
    const cached = await readCanonicalPointCache<AirQualityForecastResponse>(
      ctx.upstreamRuntime,
      key,
    );
    const orchestration = await orchestrator.forecast(point, signal, preflight);
    const priorities = preflight.providerPriorities;
    const start = Date.parse(query.evaluatedAt);
    const end = start + query.hours * 60 * 60_000;
    const normalized: AirQualityEvidence[] = [];
    const normalizationFailures: Array<{
      providerId: string;
      code: "invalid_schema" | "invalid_time";
    }> = [];
    for (const result of orchestration.results) {
      for (const value of result.evidence) {
        const targetAt =
          value &&
          typeof value === "object" &&
          "forecastFor" in value &&
          typeof value.forecastFor === "string"
            ? value.forecastFor
            : query.evaluatedAt;
        try {
          normalized.push(
            normalizeProviderEvidence(value, {
              targetAt,
              mode: "forecast",
              localStandardId: jurisdiction.localStandardId,
              comparisonStandardId: query.comparisonStandard ?? null,
              subdivisionCode: jurisdiction.subdivisionCode,
            }).evidence,
          );
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
    const inWindowNormalized = normalized.filter((item) => {
      const frame = Date.parse(item.forecastFor ?? "");
      return Number.isFinite(frame) && frame >= start && frame < end;
    });
    const deduplicated = deduplicateCanonicalEvidence(inWindowNormalized);
    let evidence = deduplicated.evidence
      .sort(
        (left, right) =>
          (left.forecastFor ?? "").localeCompare(right.forecastFor ?? "") ||
          (priorities[left.providerId] ?? Number.MAX_SAFE_INTEGER) -
            (priorities[right.providerId] ?? Number.MAX_SAFE_INTEGER) ||
          left.observationId.localeCompare(right.observationId),
      )
      .slice(0, MAX_FORECAST_EVIDENCE);
    let truncated =
      orchestration.diagnostics.truncated || deduplicated.evidence.length > MAX_FORECAST_EVIDENCE;
    const failed = [...orchestration.diagnostics.providersFailed, ...normalizationFailures].sort(
      (a, b) => a.providerId.localeCompare(b.providerId),
    );
    const windowStart = new Date(start).toISOString();
    const windowEnd = new Date(end).toISOString();

    const build = (items: AirQualityEvidence[]): AirQualityForecastResponse => {
      const grouped = groupForecastEvidence({
        windowStart,
        windowEnd,
        evidence: items,
        selectFrame: (frameAt, frameEvidence) => {
          const resolved = jurisdiction.localStandardId
            ? resolveStandard(jurisdiction.localStandardId, frameAt)
            : null;
          return selectAirQuality({
            evidence: frameEvidence,
            localStandardId: jurisdiction.localStandardId,
            localStandardRevision: resolved?.ok ? resolved.resolvedRevision : null,
            targetAt: frameAt,
            providerPriorities: priorities,
            allowStale: true,
          });
        },
      });
      const globallyDegraded =
        failed.length > 0 ||
        orchestration.diagnostics.providersPolicyExcluded.length > 0 ||
        truncated ||
        deduplicated.conflictingIds.length > 0;
      let comparisonTruncated = false;
      const frames = grouped.frames.map((frame) => {
        const primaryEvidence = items.find(
          ({ observationId }) => observationId === frame.selection.primaryEvidenceId,
        );
        const comparisonAll = query.comparisonStandard
          ? frame.evidenceIds.flatMap((evidenceId) => {
              const item = items.find(({ observationId }) => observationId === evidenceId);
              return (
                item?.indices
                  .filter(({ standardId }) => standardId === query.comparisonStandard)
                  .map(({ indexId }) => ({ evidenceId, indexId })) ?? []
              );
            })
          : [];
        if (comparisonAll.length > 32) comparisonTruncated = true;
        const comparison = comparisonAll.slice(0, 32);
        const unavailable =
          frame.evidenceIds.length === 0 || frame.selection.primaryEvidenceId === null;
        const partial =
          !unavailable &&
          (globallyDegraded ||
            primaryEvidence?.freshness === "stale" ||
            comparisonTruncated ||
            (query.comparisonStandard !== undefined && comparison.length === 0));
        return {
          frameAt: frame.frameAt,
          status: unavailable
            ? ("unavailable" as const)
            : partial
              ? ("partial" as const)
              : ("ok" as const),
          evidenceIds: frame.evidenceIds,
          primary:
            frame.selection.primaryEvidenceId === null
              ? null
              : {
                  evidenceId: frame.selection.primaryEvidenceId,
                  indexId: frame.selection.primaryIndexId,
                },
          comparison,
          selection: compact(frame.selection),
        };
      });
      const warnings = new Set<AirQualityWarningCode>();
      if (jurisdiction.resolution === "unresolved" || jurisdiction.resolution === "ambiguous")
        warnings.add("jurisdiction_unresolved");
      if (jurisdiction.requestHintMatched === false) warnings.add("jurisdiction_hint_mismatch");
      if (failed.length > 0) warnings.add("partial_providers");
      if (orchestration.diagnostics.providersPolicyExcluded.length > 0)
        warnings.add("policy_excluded");
      if (truncated) warnings.add("quota_truncated");
      if (comparisonTruncated) warnings.add("quota_truncated");
      if (deduplicated.conflictingIds.length > 0) warnings.add("duplicate_conflict");
      if (query.comparisonStandard && frames.some(({ comparison }) => comparison.length === 0))
        warnings.add("comparison_unavailable");
      const hasAvailable = frames.some(({ status }) => status !== "unavailable");
      const overallPartial =
        frames.some(({ status }) => status !== "ok") || globallyDegraded || comparisonTruncated;
      return {
        status: !hasAvailable ? "unavailable" : overallPartial ? "partial" : "ok",
        jurisdiction,
        window: { startAt: windowStart, endAt: windowEnd, requestedHours: query.hours },
        comparisonStandardId: query.comparisonStandard ?? null,
        evidence: grouped.evidence,
        series: grouped.series,
        frames,
        meta: {
          generatedAt: new Date().toISOString(),
          cache: "miss",
          providersCandidate: orchestration.diagnostics.providersCandidate,
          providersServed: orchestration.diagnostics.providersServed,
          providersFailed: failed,
          providersPolicyExcluded: orchestration.diagnostics.providersPolicyExcluded,
          truncated,
          warnings: [...warnings].sort(),
        },
      };
    };

    let response = build(evidence);
    while (evidence.length > 1 && bytes(response) > MAX_RESPONSE_BYTES) {
      evidence = evidence.slice(0, -1);
      truncated = true;
      response = build(evidence);
    }
    if (bytes(response) > MAX_RESPONSE_BYTES) throw new NormalizedResponseTooLargeError();
    const parsed = airQualityForecastResponseSchema.parse(response);
    if (normalized.length === 0 && failed.length > 0 && cached.state !== "miss") {
      const stale = airQualityForecastResponseSchema.safeParse(cached.value);
      if (stale.success) {
        const cachedEvidence = stale.data.evidence.filter((item) => {
          const frame = Date.parse(item.forecastFor ?? "");
          return Number.isFinite(frame) && frame >= start && frame < end;
        });
        if (cachedEvidence.length === 0) return parsed;
        const regrouped = build(cachedEvidence);
        const staleWarnings = new Set<AirQualityWarningCode>(regrouped.meta.warnings);
        const cacheState = cached.state === "fresh" ? "fresh" : "stale";
        if (cacheState === "stale") staleWarnings.add("stale_cache");
        staleWarnings.add("partial_providers");
        return {
          ...regrouped,
          status: regrouped.status === "unavailable" ? "unavailable" : "partial",
          meta: {
            ...regrouped.meta,
            cache: cacheState,
            warnings: [...staleWarnings].sort(),
          },
        };
      }
    }
    if (parsed.evidence.length > 0)
      await writeCanonicalPointCache(ctx.upstreamRuntime, key, parsed);
    return parsed;
  };
}

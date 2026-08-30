import type { AirQualityProviderFailureCode, ProviderEvidence } from "@openmapx/air-quality";
import {
  type AirQualityProvider,
  type ForecastAirQualityQuery,
  type IntegrationContext,
  type PointAirQualityQuery,
  ProviderCancelledError,
  ProviderTimeoutError,
  runWithProviderDeadline,
  type StationEvidencePage,
  type StationViewportQuery,
} from "@openmapx/integration-framework";

import { type DiscoveredAirQualityProvider, discoverAirQualityProviders } from "./providers.js";

const PARENT_TIMEOUT_MS = 5_000;

export interface AirQualityProviderDiagnostics {
  providersCandidate: string[];
  providersServed: string[];
  providersFailed: Array<{ providerId: string; code: AirQualityProviderFailureCode }>;
  providersPolicyExcluded: string[];
  truncated: boolean;
}

export interface ProviderEvidenceResult {
  provider: AirQualityProvider;
  evidence: ProviderEvidence[];
}

export interface PointOrchestrationResult {
  results: ProviderEvidenceResult[];
  diagnostics: AirQualityProviderDiagnostics;
}

export interface StationOrchestrationResult {
  results: Array<{ provider: AirQualityProvider; page: StationEvidencePage }>;
  diagnostics: AirQualityProviderDiagnostics;
}

interface EligibleProviders {
  candidates: DiscoveredAirQualityProvider[];
  runnable: DiscoveredAirQualityProvider[];
  policyExcluded: string[];
  unhealthy: string[];
  probes: string[];
}

export interface AirQualityPreflight {
  providersCandidate: string[];
  providersRunnable: string[];
  providersPolicyExcluded: string[];
  providersUnhealthy: string[];
  providersProbe: string[];
  providerPriorities: Readonly<Record<string, number>>;
  /** Request-local dispatch state; callers must not persist or inspect it. */
  readonly prepared: EligibleProviders;
}

function failureCode(error: unknown): AirQualityProviderFailureCode {
  if (error instanceof ProviderTimeoutError) return "provider_timeout";
  if (error instanceof ProviderCancelledError) return "cancelled";
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code: unknown }).code)
      : null;
  if (code === "quota_exhausted") return "quota_exhausted";
  if (code === "invalid_response") return "invalid_schema";
  if (code === "invalid_request") return "invalid_time";
  if (code === "unauthorized") return "unauthorized";
  if (code === "forbidden") return "forbidden";
  if (code === "upstream_failure") return "upstream_failure";
  return "upstream_failure";
}

function healthOutcome(code: AirQualityProviderFailureCode) {
  if (code === "provider_timeout") return "timeout" as const;
  if (code === "invalid_schema") return "invalid_payload" as const;
  if (code === "unauthorized" || code === "forbidden") return "auth" as const;
  if (code === "quota_exhausted") return "quota" as const;
  if (code === "cancelled") return "caller_cancelled" as const;
  return "connection" as const;
}

function coversPoint(provider: AirQualityProvider, query: PointAirQualityQuery): boolean {
  const bbox = provider.coverage.bbox;
  return (
    !bbox ||
    (query.longitude >= bbox[0] &&
      query.longitude <= bbox[2] &&
      query.latitude >= bbox[1] &&
      query.latitude <= bbox[3])
  );
}

function providerTimeout(
  provider: AirQualityProvider,
  method: "current" | "forecast" | "stations",
): number {
  const methodDefault = method === "forecast" ? 4_000 : 3_000;
  return Math.min(provider.timeoutMs ?? methodDefault, methodDefault);
}

export function createAirQualityOrchestrator(ctx: IntegrationContext) {
  async function eligible(
    capability: "current" | "forecast" | "stations",
    point?: PointAirQualityQuery,
  ): Promise<EligibleProviders> {
    const candidates = discoverAirQualityProviders(ctx).filter(
      ({ provider }) =>
        provider.capabilities.has(capability) && (!point || coversPoint(provider, point)),
    );
    const disallowed = (await ctx.getDisallowedSourceIds?.()) ?? new Set<string>();
    const policyExcluded = candidates
      .filter(({ provider }) => provider.sourceIds.some((sourceId) => disallowed.has(sourceId)))
      .map(({ provider }) => provider.id);
    const permitted = candidates.filter(({ provider }) => !policyExcluded.includes(provider.id));
    const runnable: DiscoveredAirQualityProvider[] = [];
    const unhealthy: string[] = [];
    const probes: string[] = [];
    for (const item of permitted) {
      if (!ctx.providerHealth) {
        runnable.push(item);
        continue;
      }
      try {
        const snapshot = await ctx.providerHealth.getSnapshot(item.provider.id);
        if (snapshot.state === "open" && !snapshot.ownsHalfOpenProbe)
          unhealthy.push(item.provider.id);
        else {
          runnable.push(item);
          if (snapshot.ownsHalfOpenProbe) probes.push(item.provider.id);
        }
      } catch {
        // Health-store outages fail open; quota state remains independently fail-closed.
        runnable.push(item);
      }
    }
    for (const providerId of policyExcluded) {
      ctx.metricsRecorder?.recordAirQualityProviderCall?.({
        providerId,
        method: capability,
        outcome: "skipped",
        cacheResult: "bypass",
        suppression: "policy",
        latencyMs: 0,
      });
    }
    for (const providerId of unhealthy) {
      ctx.metricsRecorder?.recordAirQualityProviderCall?.({
        providerId,
        method: capability,
        outcome: "skipped",
        cacheResult: "bypass",
        suppression: "health",
        latencyMs: 0,
      });
    }
    return {
      candidates,
      runnable,
      policyExcluded: policyExcluded.sort(),
      unhealthy: unhealthy.sort(),
      probes: probes.sort(),
    };
  }

  async function runEvidence(
    method: "current" | "forecast",
    query: PointAirQualityQuery | ForecastAirQualityQuery,
    signal?: AbortSignal,
    prepared?: EligibleProviders,
  ): Promise<PointOrchestrationResult> {
    const selection = prepared ?? (await eligible(method, query));
    const parent = new AbortController();
    const parentSignal = signal ? AbortSignal.any([signal, parent.signal]) : parent.signal;
    const timer = setTimeout(() => parent.abort(new ProviderTimeoutError()), PARENT_TIMEOUT_MS);
    try {
      const settled = await Promise.all(
        selection.runnable.map(async ({ provider }) => {
          const startedAt = Date.now();
          try {
            const evidence = await runWithProviderDeadline(
              (call) => {
                if (method === "current")
                  return provider.getCurrent?.(query, call) ?? Promise.resolve([]);
                return (
                  provider.getForecast?.(query as ForecastAirQualityQuery, call) ??
                  Promise.resolve([])
                );
              },
              { signal: parentSignal, timeoutMs: providerTimeout(provider, method) },
            );
            const maximum = method === "current" ? 4 : 120;
            const bounded = evidence.slice(0, maximum);
            const latencyMs = Date.now() - startedAt;
            if (bounded.length > 0)
              await ctx.providerHealth
                ?.recordSuccess(provider.id, latencyMs)
                .catch(() => undefined);
            else
              await ctx.providerHealth
                ?.recordFailure(provider.id, latencyMs, "valid_empty")
                .catch(() => undefined);
            ctx.metricsRecorder?.recordAirQualityProviderCall?.({
              providerId: provider.id,
              method,
              outcome: bounded.length > 0 ? "ok" : "empty",
              cacheResult: "provider-managed",
              suppression: "none",
              latencyMs,
            });
            return {
              ok: true as const,
              provider,
              evidence: bounded,
              truncated: evidence.length > maximum,
            };
          } catch (error) {
            const code = parent.signal.aborted ? "provider_timeout" : failureCode(error);
            const latencyMs = Date.now() - startedAt;
            await ctx.providerHealth
              ?.recordFailure(
                provider.id,
                latencyMs,
                healthOutcome(code),
                error instanceof Error ? error.message : undefined,
              )
              .catch(() => undefined);
            ctx.metricsRecorder?.recordAirQualityProviderCall?.({
              providerId: provider.id,
              method,
              outcome:
                code === "provider_timeout"
                  ? "timeout"
                  : code === "cancelled"
                    ? "cancelled"
                    : "error",
              cacheResult: "provider-managed",
              suppression: "none",
              latencyMs,
            });
            return { ok: false as const, provider, code };
          }
        }),
      );
      if (signal?.aborted) throw signal.reason ?? new ProviderCancelledError();
      const failed = [
        ...selection.unhealthy.map((providerId) => ({
          providerId,
          code: "provider_unhealthy" as const,
        })),
        ...settled.flatMap((item) =>
          item.ok ? [] : [{ providerId: item.provider.id, code: item.code }],
        ),
      ].sort((a, b) => a.providerId.localeCompare(b.providerId));
      const results = settled.flatMap((item) =>
        item.ok ? [{ provider: item.provider, evidence: item.evidence }] : [],
      );
      return {
        results,
        diagnostics: {
          providersCandidate: selection.candidates.map(({ provider }) => provider.id).sort(),
          providersServed: results.map(({ provider }) => provider.id).sort(),
          providersFailed: failed,
          providersPolicyExcluded: selection.policyExcluded,
          truncated: settled.some((item) => item.ok && item.truncated),
        },
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async function stations(
    query: StationViewportQuery,
    signal?: AbortSignal,
    prepared?: EligibleProviders,
  ): Promise<StationOrchestrationResult> {
    const selection = prepared ?? (await eligible("stations"));
    const parent = new AbortController();
    const parentSignal = signal ? AbortSignal.any([signal, parent.signal]) : parent.signal;
    const timer = setTimeout(() => parent.abort(new ProviderTimeoutError()), PARENT_TIMEOUT_MS);
    try {
      const settled = await Promise.all(
        selection.runnable.map(async ({ provider }) => {
          const startedAt = Date.now();
          try {
            const page = await runWithProviderDeadline(
              (call) =>
                provider.getStations?.(query, call) ?? Promise.reject(new Error("missing method")),
              { signal: parentSignal, timeoutMs: providerTimeout(provider, "stations") },
            );
            const latencyMs = Date.now() - startedAt;
            if (page.evidence.length > 0)
              await ctx.providerHealth
                ?.recordSuccess(provider.id, latencyMs)
                .catch(() => undefined);
            else
              await ctx.providerHealth
                ?.recordFailure(provider.id, latencyMs, "valid_empty")
                .catch(() => undefined);
            ctx.metricsRecorder?.recordAirQualityProviderCall?.({
              providerId: provider.id,
              method: "stations",
              outcome: page.evidence.length > 0 ? "ok" : "empty",
              cacheResult: "provider-managed",
              suppression: "none",
              latencyMs,
            });
            return { ok: true as const, provider, page };
          } catch (error) {
            const code = parent.signal.aborted ? "provider_timeout" : failureCode(error);
            const latencyMs = Date.now() - startedAt;
            await ctx.providerHealth
              ?.recordFailure(provider.id, latencyMs, healthOutcome(code))
              .catch(() => undefined);
            ctx.metricsRecorder?.recordAirQualityProviderCall?.({
              providerId: provider.id,
              method: "stations",
              outcome:
                code === "provider_timeout"
                  ? "timeout"
                  : code === "cancelled"
                    ? "cancelled"
                    : "error",
              cacheResult: "provider-managed",
              suppression: "none",
              latencyMs,
            });
            return { ok: false as const, provider, code };
          }
        }),
      );
      if (signal?.aborted) throw signal.reason ?? new ProviderCancelledError();
      const results = settled.flatMap((item) =>
        item.ok ? [{ provider: item.provider, page: item.page }] : [],
      );
      return {
        results,
        diagnostics: {
          providersCandidate: selection.candidates.map(({ provider }) => provider.id).sort(),
          providersServed: results.map(({ provider }) => provider.id).sort(),
          providersFailed: [
            ...selection.unhealthy.map((providerId) => ({
              providerId,
              code: "provider_unhealthy" as const,
            })),
            ...settled.flatMap((item) =>
              item.ok ? [] : [{ providerId: item.provider.id, code: item.code }],
            ),
          ].sort((a, b) => a.providerId.localeCompare(b.providerId)),
          providersPolicyExcluded: selection.policyExcluded,
          truncated: settled.some((item) => item.ok && item.page.truncated),
        },
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    preflight: async (
      capability: "current" | "forecast" | "stations",
      point?: PointAirQualityQuery,
    ) => {
      const selection = await eligible(capability, point);
      return {
        providersCandidate: selection.candidates.map(({ provider }) => provider.id).sort(),
        providersRunnable: selection.runnable.map(({ provider }) => provider.id).sort(),
        providersPolicyExcluded: selection.policyExcluded,
        providersUnhealthy: selection.unhealthy,
        providersProbe: selection.probes,
        providerPriorities: Object.fromEntries(
          selection.candidates.map(({ provider }) => [provider.id, provider.priority]),
        ),
        prepared: selection,
      };
    },
    current: (query: PointAirQualityQuery, signal?: AbortSignal, preflight?: AirQualityPreflight) =>
      runEvidence("current", query, signal, preflight?.prepared),
    forecast: (
      query: ForecastAirQualityQuery,
      signal?: AbortSignal,
      preflight?: AirQualityPreflight,
    ) => runEvidence("forecast", query, signal, preflight?.prepared),
    stations: (
      query: StationViewportQuery,
      signal?: AbortSignal,
      preflight?: AirQualityPreflight,
    ) => stations(query, signal, preflight?.prepared),
  };
}

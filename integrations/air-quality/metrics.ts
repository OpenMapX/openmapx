import type {
  AirQualityCurrentResponse,
  AirQualityForecastResponse,
  AirQualityStationsResponse,
} from "@openmapx/air-quality";
import type { AirQualityMetrics, IntegrationContext } from "@openmapx/integration-framework";

type PointResponse = AirQualityCurrentResponse | AirQualityForecastResponse;

function headline(response: PointResponse): AirQualityMetrics["headlineClass"] {
  if (!("primaryEvidenceId" in response)) {
    const primary = response.frames.find(({ primary }) => primary !== null)?.primary;
    if (!primary) return "none";
    const evidence = response.evidence.find(
      ({ observationId }) => observationId === primary.evidenceId,
    );
    const index = evidence?.indices.find(({ indexId }) => indexId === primary.indexId);
    if (index?.authority === "official-agency") return "official";
    if (index?.derivation === "openmapx-computed-index" && index.basis === "ground")
      return "computed-ground";
    if (evidence?.basis === "ground") return "raw-ground";
    return evidence?.basis ?? "none";
  }
  const evidence = response.evidence.find(
    ({ observationId }) => observationId === response.primaryEvidenceId,
  );
  const index = evidence?.indices.find(({ indexId }) => indexId === response.primaryIndexId);
  if (index?.authority === "official-agency") return "official";
  if (index?.derivation === "openmapx-computed-index" && index.basis === "ground")
    return "computed-ground";
  if (evidence?.basis === "ground") return "raw-ground";
  return evidence?.basis ?? "none";
}

function rejection(response: PointResponse): AirQualityMetrics["rejectionCode"] {
  const rejected =
    "selection" in response
      ? response.selection.rejected
      : response.frames.flatMap(({ selection }) => selection.rejected);
  const reasons = new Set(rejected.flatMap(({ reasons }) => reasons));
  if (reasons.has("invalid_schema")) return "invalid-schema";
  if (reasons.has("invalid_time")) return "invalid-time";
  if (reasons.has("incoherent_series")) return "incoherent-evidence";
  if (reasons.has("incomplete_window") || reasons.has("missing_required_pollutant"))
    return "incomplete-window";
  if (reasons.has("unverified_method")) return "unverified-method";
  if (reasons.has("wrong_standard")) return "wrong-standard";
  if (reasons.has("policy_disallowed")) return "policy";
  if (reasons.has("quota_exhausted")) return "quota";
  return "none";
}

export function recordPointMetric(
  ctx: IntegrationContext,
  method: "current" | "forecast",
  response: PointResponse,
  startedAt: number,
): void {
  ctx.metricsRecorder?.recordAirQuality?.({
    method,
    outcome: response.status,
    cacheResult: response.meta.cache,
    headlineClass: headline(response),
    rejectionCode: rejection(response),
    compatibilityUse: "none",
    quotaTruncated: response.meta.truncated,
    evidenceCount: response.evidence.length,
    latencyMs: Date.now() - startedAt,
  });
}

export function recordStationsMetric(
  ctx: IntegrationContext,
  response: AirQualityStationsResponse,
  startedAt: number,
): void {
  ctx.metricsRecorder?.recordAirQuality?.({
    method: "stations",
    outcome:
      response.features.length === 0
        ? "empty"
        : response.meta.providersFailed.length > 0 || response.meta.truncated
          ? "partial"
          : "ok",
    cacheResult: response.meta.cache,
    headlineClass: response.features.length > 0 ? "raw-ground" : "none",
    rejectionCode: response.meta.providersPolicyExcluded.length > 0 ? "policy" : "none",
    compatibilityUse: "none",
    quotaTruncated: response.meta.truncated,
    evidenceCount: response.features.length,
    latencyMs: Date.now() - startedAt,
  });
}

export function recordCanonicalError(
  ctx: IntegrationContext,
  method: "current" | "forecast" | "stations",
  startedAt: number,
): void {
  ctx.metricsRecorder?.recordAirQuality?.({
    method,
    outcome: "error",
    cacheResult: "bypass",
    headlineClass: "none",
    rejectionCode: "invalid-schema",
    compatibilityUse: "none",
    quotaTruncated: false,
    evidenceCount: 0,
    latencyMs: Date.now() - startedAt,
  });
}

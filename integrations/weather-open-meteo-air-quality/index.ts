import {
  type AirQualityMetrics,
  type IntegrationContext,
  QueryValidationError,
  runWithProviderDeadline,
  scalarQuery,
} from "@openmapx/integration-framework";

import { createOpenMeteoAirQualityProvider, getOpenMeteoLegacyCurrent } from "./provider.js";

function coordinate(query: Record<string, string | string[] | undefined>, key: "lat" | "lng") {
  const raw = scalarQuery(query, key);
  if (raw === undefined || raw.trim() === "") throw new QueryValidationError(key, "is required");
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new QueryValidationError(key, "must be finite");
  return value;
}

export function setup(ctx: IntegrationContext): void {
  ctx.registerAirQualityProvider(createOpenMeteoAirQualityProvider(ctx));

  ctx.registerRoute("GET", "/aqi", async (req, reply) => {
    reply.header("Deprecation", "true");
    reply.header("Sunset", "Sun, 28 Feb 2027 00:00:00 GMT");
    reply.header("Link", '</api/integrations/air-quality/current>; rel="successor-version"');
    const startedAt = Date.now();
    let metricOutcome: AirQualityMetrics["outcome"] = "error";
    let metricRejection: AirQualityMetrics["rejectionCode"] = "none";
    let evidenceCount = 0;
    try {
      const latitude = coordinate(req.query, "lat");
      const longitude = coordinate(req.query, "lng");
      if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
        metricOutcome = "rejected";
        metricRejection = "invalid-schema";
        reply.status(400).send({ message: "lat must be -90..90, lng must be -180..180" });
        return;
      }
      const disallowed = (await ctx.getDisallowedSourceIds?.()) ?? new Set<string>();
      const disallowedIntegrations = await ctx.getDisallowedIntegrationIds?.();
      if (disallowed.has("open-meteo-air-quality") || disallowedIntegrations?.has(ctx.id)) {
        metricOutcome = "rejected";
        metricRejection = "policy";
        reply
          .status(503)
          .send({ message: "Open-Meteo air quality is disabled by data-use policy" });
        return;
      }
      const result = await runWithProviderDeadline(
        (call) =>
          getOpenMeteoLegacyCurrent(
            ctx,
            { latitude, longitude, evaluatedAt: new Date().toISOString() },
            call,
          ),
        { signal: req.signal, timeoutMs: 3_000 },
      );
      metricOutcome = "ok";
      evidenceCount = 1;
      reply.send(result);
    } catch (error) {
      if (error instanceof QueryValidationError) {
        metricOutcome = "rejected";
        metricRejection = "invalid-schema";
        reply.status(400).send({ message: "lat and lng query parameters are required" });
        return;
      }
      ctx.log.warn(
        `Open-Meteo air-quality compatibility request failed: ${error instanceof Error ? error.message : "unknown error"}`,
      );
      reply.status(502).send({ message: "Upstream air quality API error" });
    } finally {
      ctx.metricsRecorder?.recordAirQuality?.({
        method: "current",
        outcome: metricOutcome,
        cacheResult: "bypass",
        headlineClass: evidenceCount > 0 ? "model" : "none",
        rejectionCode: metricRejection,
        compatibilityUse: "legacy-open-meteo",
        quotaTruncated: false,
        evidenceCount,
        latencyMs: Date.now() - startedAt,
      });
    }
  });
}

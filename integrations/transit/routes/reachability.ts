import type { IntegrationContext, RouteHandler } from "@openmapx/integration-framework";
import {
  parseTransitIsochroneRequest,
  TRANSIT_ISOCHRONE_METHOD,
  type TransitIsochroneRequest,
  type TransitIsochroneResult,
} from "@openmapx/mobility-core/transit-isochrone";
import {
  parseTransitReachabilityCheckRequest,
  parseTransitReachabilitySurfaceRequest,
  type TransitReachabilityCheckRequest,
  type TransitReachabilitySurfaceRequest,
} from "@openmapx/mobility-core/transit-reachability";
import {
  buildIsochroneFeatureCollection,
  samplingFromField,
  transitIsochroneFieldCacheKey,
  withSingleFlight,
} from "../isochrone.js";
import type { TransitOrchestrator } from "../orchestrator.js";
import {
  thinTransitReachabilitySurface,
  transitCheckCacheKey,
  transitSurfaceCacheKey,
} from "../reachability.js";
import { toEnvelope } from "../route-helpers.js";

function reachabilityFailure(error: unknown, signal?: AbortSignal) {
  const raw = (error as { code?: unknown }).code;
  const errorKind = [
    "unavailable",
    "timeout",
    "invalid-response",
    "unsupported",
    "upstream",
  ].includes(String(raw))
    ? (raw as "unavailable" | "timeout" | "invalid-response" | "unsupported" | "upstream")
    : signal?.aborted
      ? "timeout"
      : "upstream";
  return {
    errorKind,
    outcome: signal?.aborted
      ? ("cancelled" as const)
      : errorKind === "timeout"
        ? ("timeout" as const)
        : errorKind === "unavailable" || errorKind === "unsupported"
          ? ("unavailable" as const)
          : ("error" as const),
  };
}

/** Handlers for reachability capabilities, surfaces, exact checks and isochrones. */
export function createReachabilityHandlers(
  ctx: IntegrationContext,
  orchestrator: TransitOrchestrator,
) {
  return {
    async capabilities(_req, reply) {
      const startedAt = Date.now();
      const capabilities = await orchestrator.getReachabilityCapabilities();
      if (!capabilities) {
        ctx.metricsRecorder?.recordTransitReachability?.({
          operation: "capabilities",
          source: "none",
          capabilityState: "runtime-unhealthy",
          outcome: "unavailable",
          cacheOutcome: "none",
          errorKind: "unavailable",
          latencyMs: Date.now() - startedAt,
        });
        reply.status(503).send({ error: "Transit reachability is unavailable" });
        return;
      }
      ctx.metricsRecorder?.recordTransitReachability?.({
        operation: "capabilities",
        source:
          capabilities.exactPointCheckReason === "hosted-source"
            ? "transitous"
            : "self-hosted-motis",
        capabilityState: capabilities.exactPointCheckReason,
        outcome: "ok",
        cacheOutcome: "none",
        errorKind: "none",
        latencyMs: Date.now() - startedAt,
      });
      reply.header("Cache-Control", "no-store");
      reply.send(capabilities);
    },

    async surface(req, reply) {
      const startedAt = Date.now();
      let request: TransitReachabilitySurfaceRequest;
      try {
        request = parseTransitReachabilitySurfaceRequest(req.body);
      } catch (error) {
        reply.status(400).send({ error: (error as Error).message });
        return;
      }
      try {
        const capabilities = await orchestrator.getReachabilityCapabilities();
        if (!capabilities?.estimatedSurface) {
          ctx.metricsRecorder?.recordTransitReachability?.({
            operation: "surface",
            source: "none",
            capabilityState: capabilities?.exactPointCheckReason ?? "runtime-unhealthy",
            outcome: "unavailable",
            cacheOutcome: "none",
            errorKind: "unavailable",
            latencyMs: Date.now() - startedAt,
          });
          reply.status(503).send({ error: "Transit reachability is unavailable" });
          return;
        }
        const cacheKey = transitSurfaceCacheKey(request, capabilities.datasetEpoch);
        let cacheMiss = false;
        const result = await ctx.cache.withCache(cacheKey, 300, async () => {
          cacheMiss = true;
          const providerResult = await orchestrator.getReachabilitySurface(request, req.signal);
          return {
            ...providerResult,
            data: thinTransitReachabilitySurface(providerResult.data),
          };
        });
        ctx.metricsRecorder?.recordTransitReachability?.({
          operation: "surface",
          source: result.data.source,
          capabilityState: result.data.capabilities.exactPointCheckReason,
          outcome: "ok",
          cacheOutcome: cacheMiss ? "miss" : "hit",
          errorKind: "none",
          latencyMs: Date.now() - startedAt,
          rawSeedCount: result.data.thinning.originalSeedCount,
          seedCount: result.data.thinning.seedCount,
          gridMetres: result.data.thinning.gridMetres,
        });
        reply.header("Cache-Control", "public, max-age=300");
        reply.send(toEnvelope(result));
      } catch (error) {
        const failure = reachabilityFailure(error, req.signal);
        ctx.metricsRecorder?.recordTransitReachability?.({
          operation: "surface",
          source: "none",
          capabilityState: "runtime-unhealthy",
          ...failure,
          cacheOutcome: "none",
          latencyMs: Date.now() - startedAt,
        });
        reply
          .status(failure.errorKind === "timeout" ? 504 : 502)
          .send({ error: "Transit reachability failed" });
      }
    },

    async check(req, reply) {
      const startedAt = Date.now();
      let request: TransitReachabilityCheckRequest;
      try {
        request = parseTransitReachabilityCheckRequest(req.body);
      } catch (error) {
        reply.status(400).send({ error: (error as Error).message });
        return;
      }
      try {
        const capabilities = await orchestrator.getReachabilityCapabilities();
        if (!capabilities?.exactPointChecks) {
          ctx.metricsRecorder?.recordTransitReachability?.({
            operation: "exact",
            source: capabilities?.exactPointCheckReason === "hosted-source" ? "transitous" : "none",
            capabilityState: capabilities?.exactPointCheckReason ?? "runtime-unhealthy",
            outcome: "unavailable",
            cacheOutcome: "none",
            errorKind: "unavailable",
            latencyMs: Date.now() - startedAt,
            destinationCount: request.destinations.length,
            batchCount: 0,
          });
          reply.status(409).send({
            error: "Exact transit reachability is unavailable",
            reason: capabilities?.exactPointCheckReason ?? "runtime-unhealthy",
          });
          return;
        }
        const cacheKey = transitCheckCacheKey(request, capabilities.datasetEpoch);
        let cacheMiss = false;
        const result = await ctx.cache.withCache(cacheKey, 300, () => {
          cacheMiss = true;
          return orchestrator.checkReachabilityDestinations(request, req.signal);
        });
        ctx.metricsRecorder?.recordTransitReachability?.({
          operation: "exact",
          source: "self-hosted-motis",
          capabilityState: capabilities.exactPointCheckReason,
          outcome: "ok",
          cacheOutcome: cacheMiss ? "miss" : "hit",
          errorKind: "none",
          latencyMs: Date.now() - startedAt,
          destinationCount: request.destinations.length,
          batchCount: Math.ceil(
            request.destinations.length / (capabilities.maxDestinationsPerBatch ?? 1),
          ),
        });
        reply.header("Cache-Control", "private, max-age=0");
        reply.send(toEnvelope(result));
      } catch (error) {
        const failure = reachabilityFailure(error, req.signal);
        ctx.metricsRecorder?.recordTransitReachability?.({
          operation: "exact",
          source: "self-hosted-motis",
          capabilityState: "runtime-unhealthy",
          ...failure,
          cacheOutcome: "none",
          latencyMs: Date.now() - startedAt,
          destinationCount: request.destinations.length,
        });
        if (failure.errorKind === "unsupported" || failure.errorKind === "unavailable") {
          reply.status(409).send({ error: "Exact transit reachability is unavailable" });
          return;
        }
        reply
          .status(failure.errorKind === "timeout" ? 504 : 502)
          .send({ error: "Exact transit check failed" });
      }
    },

    async isochrone(req, reply) {
      const startedAt = Date.now();
      let request: TransitIsochroneRequest;
      try {
        request = parseTransitIsochroneRequest(req.body);
      } catch (error) {
        reply.status(400).send({ error: (error as Error).message });
        return;
      }
      try {
        const capabilities = await orchestrator.getReachabilityCapabilities();
        if (!capabilities?.exportableIsochrones) {
          ctx.metricsRecorder?.recordTransitReachability?.({
            operation: "isochrone",
            source:
              capabilities?.exportableIsochroneReason === "hosted-source" ? "transitous" : "none",
            capabilityState: capabilities?.exportableIsochroneReason ?? "runtime-unhealthy",
            outcome: "unavailable",
            cacheOutcome: "none",
            errorKind: "unavailable",
            latencyMs: Date.now() - startedAt,
          });
          reply.status(409).send({
            error: "Exportable transit isochrones are unavailable",
            reason: capabilities?.exportableIsochroneReason ?? "runtime-unhealthy",
          });
          return;
        }

        // Only the sampled field is cached, under a key that excludes
        // thresholds. Contouring then runs on every request, so changing a
        // threshold re-contours a cached field in milliseconds instead of
        // re-sampling for a minute.
        const { fieldResult, cacheMiss } = await withSingleFlight("transit-isochrone", async () => {
          const cacheKey = transitIsochroneFieldCacheKey(request, capabilities.datasetEpoch);
          let miss = false;
          const cached = await ctx.cache.withCache(cacheKey, 900, () => {
            miss = true;
            return orchestrator.getTransitTravelTimeField(request, req.signal);
          });
          return { fieldResult: cached, cacheMiss: miss };
        });

        const field = fieldResult.data;
        const sampling = samplingFromField(field);
        const data: TransitIsochroneResult = {
          contributors: field.contributors,
          lineageComplete: field.lineageComplete,
          queryTime: request.queryTime,
          source: "self-hosted-motis",
          method: TRANSIT_ISOCHRONE_METHOD,
          accuracy: "sampled",
          datasetEpoch: capabilities.datasetEpoch,
          sampling,
          featureCollection: buildIsochroneFeatureCollection(field, request, {
            source: "self-hosted-motis",
            datasetEpoch: capabilities.datasetEpoch,
            attribution: fieldResult.attributions ?? [],
          }),
        };

        ctx.metricsRecorder?.recordTransitReachability?.({
          operation: "isochrone",
          source: data.source,
          capabilityState: capabilities.exportableIsochroneReason,
          outcome: "ok",
          cacheOutcome: cacheMiss ? "miss" : "hit",
          errorKind: "none",
          latencyMs: Date.now() - startedAt,
          seedCount: sampling.sampleCount,
          batchCount: sampling.batchCount,
          gridMetres: sampling.gridMetres,
        });
        reply.header("Cache-Control", "no-store");
        reply.send(toEnvelope({ ...fieldResult, data }));
      } catch (error) {
        if ((error as Error).message?.includes("already in progress")) {
          ctx.metricsRecorder?.recordTransitReachability?.({
            operation: "isochrone",
            source: "none",
            capabilityState: "available",
            outcome: "unavailable",
            cacheOutcome: "none",
            errorKind: "busy",
            latencyMs: Date.now() - startedAt,
          });
          reply.header("Retry-After", "30");
          reply.status(429).send({ error: "A transit isochrone computation is already running" });
          return;
        }
        const failure = reachabilityFailure(error, req.signal);
        ctx.metricsRecorder?.recordTransitReachability?.({
          operation: "isochrone",
          source: "none",
          capabilityState: "runtime-unhealthy",
          ...failure,
          cacheOutcome: "none",
          latencyMs: Date.now() - startedAt,
        });
        if (failure.errorKind === "unsupported" || failure.errorKind === "unavailable") {
          reply.status(409).send({ error: "Exportable transit isochrones are unavailable" });
          return;
        }
        reply
          .status(failure.errorKind === "timeout" ? 504 : 502)
          .send({ error: "Transit isochrone generation failed" });
      }
    },
  } satisfies Record<string, RouteHandler>;
}

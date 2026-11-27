import { TIME_AWARE_TEMPORAL_DEFAULT } from "@openmapx/core";
import { type RouteHandler, scalarQueries } from "@openmapx/integration-framework";
import { planTransitChain } from "../chain-plan.js";
import { ChainRequestValidationError, parseChainRequest } from "../chain-request.js";
import {
  type TransitOrchestrator,
  UnsupportedTransitPlanningCapabilitiesError,
} from "../orchestrator.js";
import { signTransitPageToken } from "../page-token.js";
import { parsePlanEndpoints, parsePlanOptions } from "../plan-request.js";
import type { RefreshSession } from "../refresh-session.js";
import { toEnvelope } from "../route-helpers.js";
import { sessionSecret } from "../session-secret.js";
import {
  parseTripReferenceRequest,
  TripReferenceEpochError,
  TripReferenceUnavailableError,
  TripReferenceUnsupportedError,
  TripReferenceValidationError,
} from "../trip-reference.js";

/** Handlers for planning: capabilities, search, exact trips, chains and refresh. */
export function createPlanHandlers(orchestrator: TransitOrchestrator, session: RefreshSession) {
  return {
    async capabilities(_req, reply) {
      const providers = orchestrator
        .collectProviders()
        .filter((provider) => provider.capabilities.planning)
        .map((provider) => ({
          id: provider.id,
          features: provider.capabilities.planningFeatures,
          metadata: provider.planningMetadata,
        }));
      reply.header("Cache-Control", "private, max-age=60");
      reply.send({ providers });
    },

    async plan(req, reply) {
      const q = scalarQueries(req.query);
      const endpoints = parsePlanEndpoints(q);
      if (!endpoints.ok) {
        reply.status(400).send({ error: endpoints.error });
        return;
      }
      reply.header("Cache-Control", "private, max-age=60");
      // Read per request, like the host reads its session secret.
      const parsed = parsePlanOptions(q, endpoints.value, sessionSecret());
      if (!parsed.ok) {
        reply.status(400).send({ error: parsed.error });
        return;
      }
      const { request: planRequest, fingerprint } = parsed.value;
      let planRes: Awaited<ReturnType<typeof orchestrator.planTrip>>;
      try {
        planRes = await orchestrator.planTrip(planRequest);
      } catch (error) {
        if (error instanceof UnsupportedTransitPlanningCapabilitiesError) {
          reply.status(422).send({
            error: "No transit planner can honor the selected requirements",
            unsupportedCapabilities: error.capabilities,
          });
          return;
        }
        throw error;
      }
      const plan = planRes.data;
      if (!plan) {
        reply.status(503).send({
          error: "Trip planning unavailable — no transit provider could serve this route",
        });
        return;
      }
      const secret = sessionSecret();
      const tokenBase = {
        source: plan.source ?? plan.provider ?? "transit-motis-local",
        instance: plan.instance ?? plan.provider ?? "local",
        datasetEpoch: plan.datasetEpoch ?? q.capability_epoch ?? "active",
        fingerprint,
      };
      if (plan.previousPageCursor) {
        plan.previousPageToken = signTransitPageToken(
          { ...tokenBase, cursor: plan.previousPageCursor, direction: "previous" },
          secret,
        );
      }
      if (plan.nextPageCursor) {
        plan.nextPageToken = signTransitPageToken(
          { ...tokenBase, cursor: plan.nextPageCursor, direction: "next" },
          secret,
        );
      }
      delete plan.previousPageCursor;
      delete plan.nextPageCursor;
      const origin = session.originForPlan(planRes, fingerprint, planRequest);
      if (origin) {
        for (const itinerary of plan.itineraries)
          itinerary.refreshToken = await session.issueForSearch(itinerary, origin);
      }
      reply.send(toEnvelope(planRes));
    },

    /** A provider reference is a distinct lookup, never an ordinary search-cache result. */
    async resolve(req, reply) {
      reply.header("Cache-Control", "no-store");
      try {
        const request = parseTripReferenceRequest(req.body);
        const result = await orchestrator.resolveTrip(request);
        if (!result.data) {
          reply.status(404).send({ error: "The exact provider trip could not be resolved" });
          return;
        }
        if (session.canRefresh(result.planner) && result.data.datasetEpoch) {
          for (const itinerary of result.data.itineraries)
            itinerary.refreshToken = await session.issueForReference(itinerary, request);
        }
        reply.send(toEnvelope(result));
      } catch (error) {
        if (error instanceof TripReferenceValidationError)
          reply.status(400).send({ error: error.message });
        else if (error instanceof TripReferenceEpochError)
          reply.status(409).send({ error: "Trip reference epoch changed" });
        else if (error instanceof TripReferenceUnsupportedError)
          reply.status(501).send({ error: "Exact trip reconstruction is unsupported" });
        else if (error instanceof TripReferenceUnavailableError)
          reply.status(503).send({ error: "Exact trip source unavailable" });
        else throw error;
      }
    },

    /**
     * A multi-stop transit trip planned around per-waypoint time windows and
     * dwell. One `planTrip` call per segment; no paging, since a chain has no
     * single cursor.
     */
    async chain(req, reply) {
      let request: ReturnType<typeof parseChainRequest>;
      try {
        request = parseChainRequest(req.body);
      } catch (error) {
        if (!(error instanceof ChainRequestValidationError)) throw error;
        reply.status(400).send({ error: error.message });
        return;
      }

      // Read the temporal contract from a provider that actually declared it can
      // serve a chain segment; the default covers a provider that declared none.
      const chainProvider = orchestrator
        .collectProviders()
        .find((provider) => provider.capabilities.planningFeatures?.chaining === true);
      const capabilities =
        chainProvider?.capabilities.planningFeatures?.temporal ?? TIME_AWARE_TEMPORAL_DEFAULT;

      try {
        const plan = await planTransitChain({
          waypoints: request.waypoints,
          schedules: request.schedules,
          anchor: request.anchor,
          baseRequest: request.baseRequest,
          planTrip: (segmentRequest) =>
            orchestrator.planTrip(segmentRequest, request.waypoints.length),
          capabilities,
          numItinerariesPerSegment: request.numItineraries,
        });
        reply.header("Cache-Control", "private, max-age=30");
        reply.send(plan);
      } catch (error) {
        if (error instanceof UnsupportedTransitPlanningCapabilitiesError) {
          reply.status(422).send({
            error: "No transit planner can honor the selected requirements",
            unsupportedCapabilities: error.capabilities,
          });
          return;
        }
        throw error;
      }
    },

    /** Opaque, one-time, server-side-bound MOTIS refresh. */
    async refresh(req, reply) {
      const handle = session.verify((req.body as { token?: unknown } | null)?.token);
      if (!handle.ok) {
        reply.status(400).send({ error: handle.error });
        return;
      }
      const result = await session.refresh(handle.id);
      reply.header("Cache-Control", "no-store");
      if (result.status === 503) reply.header("Retry-After", "2");
      reply.status(result.status).send(result.body);
    },
  } satisfies Record<string, RouteHandler>;
}

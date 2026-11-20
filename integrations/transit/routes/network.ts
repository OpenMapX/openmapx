import {
  type IntegrationContext,
  listQuery,
  type RouteHandler,
  scalarQueries,
} from "@openmapx/integration-framework";
import { snapshotContributors } from "@openmapx/mobility-core/contributors";
import type { Freshness } from "@openmapx/mobility-core/freshness";
import type { MobilityEnvelope, MobilityResult } from "@openmapx/mobility-core/result";
import type { GeoJSONLineString } from "@openmapx/mobility-core/transit";
import type { TransitOrchestrator } from "../orchestrator.js";
import { envelope, parseBBox, toEnvelope } from "./shared.js";

export function routeZoomBucket(raw: string | undefined): number {
  const parsed = Number(raw ?? 12);
  const zoom = Number.isFinite(parsed) ? Math.min(18, Math.max(0, Math.floor(parsed))) : 12;
  if (zoom >= 16) return 16;
  if (zoom >= 14) return 14;
  if (zoom >= 12) return 12;
  return 10;
}

/** Handlers for lines, their stops and live state, vehicles, area alerts and leg shapes. */
export function createNetworkHandlers(ctx: IntegrationContext, orchestrator: TransitOrchestrator) {
  return {
    async routes(req, reply) {
      if (scalarQueries(req.query).stop_id) {
        const stopId = scalarQueries(req.query).stop_id;
        const cacheKey = `transit:routes-for-stop:${stopId}`;
        const routes = await ctx.cache.withCache(cacheKey, 300, async () => {
          const res = await orchestrator.getRoutesForStop(stopId);
          return toEnvelope(res);
        });
        reply.send(routes);
        return;
      }
      const bbox = parseBBox(scalarQueries(req.query));
      if (!bbox) {
        reply.status(400).send({ error: "Provide stop_id or valid bbox params" });
        return;
      }
      // The network overlay refetches on every moveend (and on style/theme
      // changes), so cache by a coarsened bbox (~110m) to collapse near-identical
      // viewports onto one upstream MOTIS call instead of hammering the always-on
      // cloud instance.
      reply.header("Cache-Control", "public, max-age=120, s-maxage=120");
      const zoom = routeZoomBucket(scalarQueries(req.query).zoom);
      const cacheKey = `transit:routes-bbox:${zoom}:${bbox.map((n) => n.toFixed(3)).join(",")}`;
      const routes = await ctx.cache.withCache(cacheKey, 120, async () => {
        const res = await orchestrator.getRoutesInBbox(bbox, zoom);
        return toEnvelope(res);
      });
      reply.send(routes);
    },

    async route(req, reply) {
      const routeId = req.params.id;
      const cacheKey = `transit:route:${routeId}`;
      const env = await ctx.cache.withCache(
        cacheKey,
        3600,
        async () => toEnvelope(await orchestrator.getRoute(routeId)),
        undefined,
        (found) => Boolean(found.data),
      );
      if (!env.data) {
        reply.status(404).send({ error: "Route not found" });
        return;
      }
      reply.send(env);
    },

    async routeStops(req, reply) {
      const routeId = req.params.id;
      const hintStopId = scalarQueries(req.query).hint_stop_id || undefined;
      const cacheKey = `transit:route-stops:${routeId}:${hintStopId ?? ""}`;
      const env = await ctx.cache.withCache(
        cacheKey,
        3600,
        async () => toEnvelope(await orchestrator.getRouteStops(routeId, hintStopId)),
        undefined,
        (stops) => Array.isArray(stops.data) && stops.data.length > 0,
      );
      reply.send(env);
    },

    async routeAlerts(req, reply) {
      reply.header("Cache-Control", "public, max-age=60, s-maxage=60");
      const routeId = req.params.id;
      const cacheKey = `transit:route-alerts:${routeId}`;
      const alerts = await ctx.cache.withCache(cacheKey, 60, async () => {
        const res = await orchestrator.getRouteAlerts(routeId);
        return toEnvelope(res);
      });
      reply.send(alerts);
    },

    async routeLive(req, reply) {
      reply.header("Cache-Control", "public, max-age=15, s-maxage=15");
      const routeId = req.params.id;
      const [vehicles, alerts] = await Promise.all([
        orchestrator.getVehiclePositions(routeId),
        orchestrator.getRouteAlerts(routeId),
      ]);
      const mergedAttrs = snapshotContributors(vehicles.attributions, alerts.attributions);
      const mergedFreshness: Freshness = {
        fetchedAt:
          vehicles.freshness.fetchedAt < alerts.freshness.fetchedAt
            ? vehicles.freshness.fetchedAt
            : alerts.freshness.fetchedAt,
        hasRealtimeData: vehicles.freshness.hasRealtimeData || alerts.freshness.hasRealtimeData,
        isStale: vehicles.freshness.isStale || alerts.freshness.isStale,
      };
      reply.send(
        envelope({ vehicles: vehicles.data, alerts: alerts.data }, mergedAttrs, mergedFreshness),
      );
    },

    async legGeometry(req, reply) {
      const tripId = scalarQueries(req.query).trip_id?.trim();
      if (!tripId) {
        reply.status(400).send({ error: "Required: trip_id" });
        return;
      }
      const fromStopId = scalarQueries(req.query).from_stop_id?.trim() || undefined;
      const toStopId = scalarQueries(req.query).to_stop_id?.trim() || undefined;
      // Trip polylines are static (trains always follow the same track), so cache
      // aggressively in Redis to avoid hammering the dbweb endpoint on every request.
      // Throw inside the callback when geometry is null so withCache does not
      // persist the failure — a transient dbweb timeout would otherwise lock the
      // trip into a 24h 404.
      const cacheKey = `leg-geo:${tripId}:${fromStopId ?? ""}:${toStopId ?? ""}`;
      let geometry: MobilityEnvelope<GeoJSONLineString> | null = null;
      try {
        geometry = await ctx.cache.withCache(cacheKey, 86400, async () => {
          const res = await orchestrator.getLegGeometry(tripId, fromStopId, toStopId);
          if (!res.data) throw new Error("geometry unavailable");
          return toEnvelope(res as MobilityResult<GeoJSONLineString>);
        });
      } catch {
        // geometry remains null — transient failure, not cached
      }
      if (!geometry?.data) {
        reply.status(404).send({ error: "Geometry not available for this trip" });
        return;
      }
      reply.header("Cache-Control", "public, max-age=3600, s-maxage=3600");
      reply.send(geometry);
    },

    async alerts(req, reply) {
      const bbox = parseBBox(scalarQueries(req.query));
      if (!bbox) {
        reply.status(400).send({ error: "Invalid or missing bbox params" });
        return;
      }
      reply.header("Cache-Control", "public, max-age=15, s-maxage=15");
      const cacheKey = `transit:alerts:${bbox.join(",")}`;
      // Leave room for the 15 s national feed cache and 15 s HTTP cache.
      const alerts = await ctx.cache.withCache(cacheKey, 30, async () => {
        const res = await orchestrator.getAlerts(bbox);
        return toEnvelope(res);
      });
      reply.send(alerts);
    },

    async vehicles(req, reply) {
      reply.header("Cache-Control", "public, max-age=15, s-maxage=15");
      if (scalarQueries(req.query).route_id) {
        const vehicles = await orchestrator.getVehiclePositions(scalarQueries(req.query).route_id);
        reply.send(toEnvelope(vehicles));
        return;
      }
      const bbox = parseBBox(scalarQueries(req.query));
      if (bbox) {
        const vehicles = await orchestrator.getVehicleRadar(bbox);
        reply.send(toEnvelope(vehicles));
        return;
      }
      reply.status(400).send({
        error: "Provide route_id or valid bbox params (sw_lat, sw_lng, ne_lat, ne_lng)",
      });
    },

    async vehicleJourney(req, reply) {
      const tripId = req.params.id;
      // Repeated `fallback_ids=a&fallback_ids=b`, each id verbatim: an id may
      // itself hold a comma or edge spaces. Empty items are dropped, so a bare
      // `fallback_ids=` reads as absent.
      const nonEmptyFallbackIds = listQuery(req.query, "fallback_ids")?.filter((id) => id !== "");
      const fallbackIds = nonEmptyFallbackIds?.length ? nonEmptyFallbackIds : undefined;
      const cacheKey = `transit:vehicle-journey:${JSON.stringify([tripId, fallbackIds ?? []])}`;
      const env = await ctx.cache.withCache(
        cacheKey,
        30,
        async () => toEnvelope(await orchestrator.getVehicleJourney(tripId, fallbackIds)),
        undefined,
        (journey) => Boolean(journey.data),
      );
      if (!env.data) {
        reply.status(404).send({ error: "Vehicle journey not found" });
        return;
      }
      reply.send(toEnvelope(await orchestrator.enrichJourneyPlatforms(env)));
    },
  } satisfies Record<string, RouteHandler>;
}

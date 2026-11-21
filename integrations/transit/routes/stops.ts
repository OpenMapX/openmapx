import { type BBox, overpassQuery } from "@openmapx/core";
import {
  type IntegrationContext,
  parsePositiveRadius,
  parseWgs84Point,
  type RouteHandler,
  type RouteParams,
  type RouteRequest,
  scalarQueries,
} from "@openmapx/integration-framework";
import type { MobilityEnvelope } from "@openmapx/mobility-core/result";
import { AnchoredDeparturesUnsupported, type TransitOrchestrator } from "../orchestrator.js";
import {
  cacheControl,
  envelope,
  parseBBox,
  parseMinutes,
  parseModes,
  toEnvelope,
} from "../route-helpers.js";
import { parseStopAreaQuery, resolveStopArea, stopAreaCacheKey } from "../stop-area.js";
import { TripReferenceUnavailableError } from "../trip-reference.js";

/** Stops and platforms move rarely; a week keeps Overpass out of most trips. */
const STOP_AREA_TTL_SECONDS = 7 * 24 * 60 * 60;

function utcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/** A request to one of the `/stops/:id/…` routes. */
type StopRequest = RouteRequest<RouteParams<"/stops/:id">>;

/** Handlers for the stop lookups: by viewport, by name, by id and per stop. */
export function createStopHandlers(ctx: IntegrationContext, orchestrator: TransitOrchestrator) {
  return {
    async inBbox(req, reply) {
      const bbox = parseBBox(scalarQueries(req.query));
      if (!bbox) {
        reply
          .status(400)
          .send({ error: "Invalid or missing bbox params (sw_lat, sw_lng, ne_lat, ne_lng)" });
        return;
      }
      const result = await orchestrator.getStopsInBbox(
        bbox,
        parseModes(scalarQueries(req.query).modes),
      );
      reply.send(toEnvelope(result));
    },

    async nearby(req, reply) {
      const point = parseWgs84Point(scalarQueries(req.query).lng, scalarQueries(req.query).lat, {
        maxAbsLatitude: 85,
      });
      const radiusMeters = parsePositiveRadius(scalarQueries(req.query).radius, {
        defaultValue: 500,
        max: 2_000,
      });
      if (!point || radiusMeters === null) {
        reply.status(400).send({ error: "Required: valid lat, lng, and radius in (0, 2000]" });
        return;
      }
      const [lng, lat] = point;
      const latDelta = radiusMeters / 111_320;
      const lngDelta = radiusMeters / (111_320 * Math.cos((lat * Math.PI) / 180));
      const bbox: BBox = [lng - lngDelta, lat - latDelta, lng + lngDelta, lat + latDelta];
      reply.header("Cache-Control", "public, max-age=300, s-maxage=300");
      const result = await orchestrator.getStopsInBbox(
        bbox,
        parseModes(scalarQueries(req.query).modes),
      );
      reply.send(toEnvelope(result));
    },

    async search(req, reply) {
      const query = scalarQueries(req.query).q?.trim();
      if (!query || query.length < 2) {
        reply.status(400).send({ error: "Query parameter 'q' must be at least 2 characters" });
        return;
      }
      const limit = Math.min(Math.max(Number(scalarQueries(req.query).limit) || 5, 1), 20);
      const stops = await orchestrator.searchByName(query, limit);
      reply.header(
        "Cache-Control",
        cacheControl(stops.freshness, "public, max-age=300, s-maxage=300"),
      );
      reply.send(toEnvelope(stops));
    },

    async byId(req: StopRequest, reply) {
      const res = await orchestrator.getStop(req.params.id);
      if (!res.data) {
        reply.status(404).send({ error: "Stop not found" });
        return;
      }
      reply.send(toEnvelope(res));
    },

    /** Accessibility-annotated transfers out of a stop. */
    async transfers(req: StopRequest, reply) {
      const stopId = req.params.id;
      const cacheKey = `stop-transfers:${stopId}`;
      const env = await ctx.cache.withCache(cacheKey, 3600, async () =>
        toEnvelope(await orchestrator.getStopTransfers(stopId)),
      );
      reply.header("Cache-Control", "public, max-age=600, s-maxage=3600");
      reply.send(env);
    },

    async infrastructure(req: StopRequest, reply) {
      const stopId = req.params.id;
      const cacheKey = `stop-infra:${stopId}`;
      let env: MobilityEnvelope<unknown> | null = null;
      try {
        env = await ctx.cache.withCache(cacheKey, 86400, async () => {
          const res = await orchestrator.getStopInfrastructure(stopId);
          if (!res.data) throw new Error("infrastructure unavailable");
          return toEnvelope(res);
        });
      } catch {
        env = null;
      }
      if (!env?.data) {
        reply.status(404).send({ error: "Stop infrastructure not found" });
        return;
      }
      reply.header("Cache-Control", "public, max-age=3600, s-maxage=86400");
      reply.send(env);
    },

    /**
     * The stop's platform and stop place, for navigation to decide that a rider
     * reached it. 204 when nothing beyond its point is known.
     */
    async area(req: StopRequest, reply) {
      const query = parseStopAreaQuery(decodeURIComponent(req.params.id), scalarQueries(req.query));
      if (!query) {
        reply.status(400).send({ error: "Invalid stop area query" });
        return;
      }
      const resolved = await ctx.cache.withCache(
        stopAreaCacheKey(query),
        STOP_AREA_TTL_SECONDS,
        () =>
          resolveStopArea(query, {
            overpass: overpassQuery,
            siblings: (stopId) => orchestrator.getStopPlatforms(stopId),
          }),
        undefined,
        (value) => value.complete,
      );
      // A lookup a source failed is worse than the next one will be: keep it
      // out of every cache, not only the server's.
      reply.header(
        "Cache-Control",
        resolved.complete ? "public, max-age=86400, s-maxage=604800" : "no-store",
      );
      if (!resolved.area) {
        reply.status(204).send(null);
        return;
      }
      reply.send(
        envelope(resolved.area, resolved.attributions, {
          fetchedAt: new Date().toISOString(),
          hasRealtimeData: false,
          isStale: false,
        }),
      );
    },

    async platformStops(req: StopRequest, reply) {
      reply.header("Cache-Control", "public, max-age=3600, s-maxage=3600");
      const result = await orchestrator.getStopPlatforms(req.params.id);
      reply.send(toEnvelope(result));
    },

    async timetable(req: StopRequest, reply) {
      const date = scalarQueries(req.query).date ?? utcDate();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        reply.status(400).send({ error: "Invalid date format. Use YYYY-MM-DD." });
        return;
      }
      const isPast = date < utcDate();
      reply.header(
        "Cache-Control",
        isPast ? "public, max-age=86400, s-maxage=86400" : "public, max-age=300, s-maxage=300",
      );
      const result = await orchestrator.getStopTimetable(req.params.id, date);
      reply.send(toEnvelope(result));
    },

    async departures(req: StopRequest, reply) {
      const minutes = parseMinutes(scalarQueries(req.query).minutes);
      if (!minutes) {
        reply.status(400).send({ error: "Invalid minutes param" });
        return;
      }
      const rawTime = scalarQueries(req.query).time;
      if (
        rawTime !== undefined &&
        (rawTime.length > 40 ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(rawTime) ||
          !Number.isFinite(Date.parse(rawTime)) ||
          new Date(rawTime).toISOString().slice(0, 10) !== rawTime.slice(0, 10))
      ) {
        reply.status(400).send({ error: "Invalid time; use an ISO UTC timestamp" });
        return;
      }
      const time = rawTime === undefined ? undefined : new Date(rawTime).toISOString();
      reply.header("Cache-Control", time ? "no-store" : "public, max-age=30, s-maxage=30");
      const stopId = req.params.id;
      const cacheKey = `transit:departures:${stopId}:${minutes}${time ? `:${time}` : ""}`;
      try {
        const result = await ctx.cache.withCache(cacheKey, 30, async () => {
          const res = await orchestrator.getDepartures(stopId, minutes, time);
          return toEnvelope(res);
        });
        reply.send(result);
      } catch (error) {
        if (error instanceof AnchoredDeparturesUnsupported) {
          reply.status(501).send({ error: "This source does not support dated departure lookups" });
          return;
        }
        if (error instanceof TripReferenceUnavailableError) {
          reply.status(503).send({ error: "Transit timetable source unavailable" });
          return;
        }
        throw error;
      }
    },

    async arrivals(req: StopRequest, reply) {
      const minutes = parseMinutes(scalarQueries(req.query).minutes);
      if (!minutes) {
        reply.status(400).send({ error: "Invalid minutes param" });
        return;
      }
      reply.header("Cache-Control", "public, max-age=60, s-maxage=60");
      const stopId = req.params.id;
      const cacheKey = `transit:arrivals:${stopId}:${minutes}`;
      const result = await ctx.cache.withCache(cacheKey, 60, async () => {
        const res = await orchestrator.getArrivals(stopId, minutes);
        return toEnvelope(res);
      });
      reply.send(result);
    },

    async alerts(req: StopRequest, reply) {
      const stopId = req.params.id;
      const cacheKey = `transit:stop-alerts:${stopId}`;
      const alerts = await ctx.cache.withCache(cacheKey, 60, async () => {
        const res = await orchestrator.getStopAlerts(stopId);
        return toEnvelope(res);
      });
      reply.header("Cache-Control", "public, max-age=60, s-maxage=60");
      reply.send(alerts);
    },

    async facilities(req: StopRequest, reply) {
      const result = await orchestrator.getFacilities(req.params.id);
      reply.send(toEnvelope(result));
    },
  } satisfies Record<string, RouteHandler>;
}

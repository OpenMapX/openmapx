import { parseWgs84Point, type RouteHandler, scalarQueries } from "@openmapx/integration-framework";
import type { PlaceQuery, PlaceTransit } from "../place-transit.js";
import { cacheControl, parseMinutes, toEnvelope } from "./shared.js";

function parsePlaceQuery(q: Record<string, string>): PlaceQuery | null {
  const name = q.name?.trim();
  const point = parseWgs84Point(q.lng, q.lat);
  if (!point || !name) return null;
  const [lng, lat] = point;
  const osmRef = q.osm_id?.trim();
  const stopName = q.stop_name?.trim().slice(0, 200);
  return {
    lat,
    lng,
    name,
    ...(q.place_id ? { placeId: q.place_id } : {}),
    ...(osmRef ? { osmRef } : {}),
    ...(stopName ? { stopName } : {}),
  };
}

/** Handlers for the transit of a place: its linked stops and their merged boards. */
export function createPlaceHandlers(placeTransit: PlaceTransit) {
  return {
    async linkedStops(req, reply) {
      const place = parsePlaceQuery(scalarQueries(req.query));
      if (!place) {
        reply.status(400).send({ error: "Required: lat, lng, name" });
        return;
      }
      const result = await placeTransit.getLinkedStops(place);
      reply.header(
        "Cache-Control",
        cacheControl(result.freshness, "public, max-age=86400, s-maxage=86400"),
      );
      reply.send(toEnvelope(result));
    },

    async routes(req, reply) {
      const place = parsePlaceQuery(scalarQueries(req.query));
      if (!place) {
        reply.status(400).send({ error: "Required: lat, lng, name" });
        return;
      }
      const result = await placeTransit.getMergedRoutes(place);
      reply.header(
        "Cache-Control",
        cacheControl(result.freshness, "public, max-age=300, s-maxage=300"),
      );
      reply.send(toEnvelope(result));
    },

    async departures(req, reply) {
      const place = parsePlaceQuery(scalarQueries(req.query));
      if (!place) {
        reply.status(400).send({ error: "Required: lat, lng, name" });
        return;
      }
      const minutes = parseMinutes(scalarQueries(req.query).minutes);
      if (!minutes) {
        reply.status(400).send({ error: "Invalid minutes param" });
        return;
      }
      reply.header("Cache-Control", "no-store");
      const result = await placeTransit.getMergedDepartures(place, minutes);
      reply.send(toEnvelope(result));
    },

    async arrivals(req, reply) {
      const place = parsePlaceQuery(scalarQueries(req.query));
      if (!place) {
        reply.status(400).send({ error: "Required: lat, lng, name" });
        return;
      }
      const minutes = parseMinutes(scalarQueries(req.query).minutes);
      if (!minutes) {
        reply.status(400).send({ error: "Invalid minutes param" });
        return;
      }
      reply.header("Cache-Control", "no-store");
      const result = await placeTransit.getMergedArrivals(place, minutes);
      reply.send(toEnvelope(result));
    },

    async alerts(req, reply) {
      const place = parsePlaceQuery(scalarQueries(req.query));
      if (!place) {
        reply.status(400).send({ error: "Required: lat, lng, name" });
        return;
      }
      const result = await placeTransit.getMergedAlerts(place);
      reply.header(
        "Cache-Control",
        cacheControl(result.freshness, "public, max-age=60, s-maxage=60"),
      );
      reply.send(toEnvelope(result));
    },

    async facilities(req, reply) {
      const place = parsePlaceQuery(scalarQueries(req.query));
      if (!place) {
        reply.status(400).send({ error: "Required: lat, lng, name" });
        return;
      }
      const result = await placeTransit.getMergedFacilities(place);
      reply.header(
        "Cache-Control",
        cacheControl(result.freshness, "public, max-age=86400, s-maxage=86400"),
      );
      reply.send(toEnvelope(result));
    },
  } satisfies Record<string, RouteHandler>;
}

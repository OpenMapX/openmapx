import type { FastifyInstance } from "fastify";
import { transitOrchestrator } from "../../services/transit/orchestrator";
import { hashKey, withCache } from "../../utils/cache";
import { utcDate, utcTime } from "./shared";

interface PlanQuery {
  from_lat: string;
  from_lng: string;
  to_lat: string;
  to_lng: string;
  time?: string;
  date?: string;
  modes?: string;
  num_itineraries?: string;
  arrive_by?: string;
  lang?: string;
}

export async function tripsRoutes(server: FastifyInstance): Promise<void> {
  // GET /api/transit/plan
  server.get<{ Querystring: PlanQuery }>("/transit/plan", {
    schema: {
      querystring: {
        type: "object",
        required: ["from_lat", "from_lng", "to_lat", "to_lng"],
        properties: {
          from_lat: { type: "string" },
          from_lng: { type: "string" },
          to_lat: { type: "string" },
          to_lng: { type: "string" },
          time: { type: "string" },
          date: { type: "string" },
          modes: { type: "string" },
          num_itineraries: { type: "string" },
          arrive_by: { type: "string" },
          lang: { type: "string" },
        },
      },
    },
    handler: async (req, reply) => {
      const q = req.query;
      const fromLat = Number(q.from_lat);
      const fromLng = Number(q.from_lng);
      const toLat = Number(q.to_lat);
      const toLng = Number(q.to_lng);
      if (
        !Number.isFinite(fromLat) ||
        !Number.isFinite(fromLng) ||
        !Number.isFinite(toLat) ||
        !Number.isFinite(toLng)
      ) {
        return reply.status(400).send({
          error: "Invalid or missing coordinate params (from_lat, from_lng, to_lat, to_lng)",
        });
      }
      reply.header("Cache-Control", "private, max-age=60");
      // Accept `time` as full ISO 8601 (from frontend) or fall back to UTC now.
      // The frontend sends the user's local time converted to UTC.
      let date: string;
      let time: string;
      if (q.time?.includes("T")) {
        // Full ISO timestamp, e.g. "2026-03-09T20:00:00Z"
        const d = new Date(q.time);
        date = d.toISOString().slice(0, 10);
        time = d.toISOString().slice(11, 19);
      } else {
        date = q.date ?? utcDate();
        // Normalize to HH:MM:SS — avoid double-appending :00 if seconds already present
        time = q.time ? (q.time.split(":").length >= 3 ? q.time : `${q.time}:00`) : utcTime();
      }
      const _numItineraries = Math.min(Math.max(Number(q.num_itineraries ?? 3), 1), 10);
      const plan = await transitOrchestrator.planTrip({
        from: { lat: fromLat, lng: fromLng },
        to: { lat: toLat, lng: toLng },
        departureTime: `${date}T${time}Z`,
        modes: (q.modes ?? "TRANSIT").split(",").map((m) => m.trim()),
      });
      if (!plan) {
        return reply.status(503).send({
          error: "Trip planning unavailable — no transit provider could serve this route",
        });
      }
      return plan;
    },
  });

  // GET /api/transit/reachable?lat=&lng=&maxTravelTime=30&modes=
  server.get(
    "/transit/reachable",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["lat", "lng"],
          properties: {
            lat: { type: "number" },
            lng: { type: "number" },
            maxTravelTime: { type: "integer", default: 30 },
            modes: { type: "string" },
          },
        },
      },
    },
    async (req, reply) => {
      const q = req.query as { lat: number; lng: number; maxTravelTime: number; modes?: string };
      const maxTravelTime = Math.min(q.maxTravelTime, 120);

      const cacheKey = hashKey("cache:transit:reachable", {
        lat: q.lat.toFixed(3),
        lng: q.lng.toFixed(3),
        maxTravelTime: String(maxTravelTime),
        modes: q.modes ?? "",
      });

      const results = await withCache(cacheKey, 300, () =>
        transitOrchestrator.getReachableStops(
          q.lat,
          q.lng,
          maxTravelTime,
          q.modes?.split(",").map((m) => m.trim()),
        ),
      );

      reply.header("Cache-Control", "public, max-age=300");
      return results;
    },
  );
}

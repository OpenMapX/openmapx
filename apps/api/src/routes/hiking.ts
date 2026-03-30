import { OverpassRateLimitError } from "@openmapx/core";
import type { FastifyPluginAsync } from "fastify";
import { fetchRouteGeometry } from "../services/hiking/overpass-geometry";
import { searchTrails, trailDetail, trailsByArea } from "../services/hiking/waymarked-trails";
import { round, TTL, withCache } from "../utils/cache.js";

const MAX_BBOX_SPAN = 1.0;

function classifyShelterType(rawType: string): string {
  const t = rawType.toLowerCase();
  if (t.includes("cabane") || t.includes("bivouac") || t.includes("abri")) return "cabane";
  if (t.includes("refuge") || t.includes("gardé")) return "refuge";
  if (t.includes("gîte") || t.includes("gite")) return "gite";
  if (t.includes("eau") || t.includes("water") || t.includes("source")) return "pt_eau";
  if (t.includes("passage") || t.includes("col") || t.includes("pass")) return "pt_passage";
  if (t.includes("hut") || t.includes("shelter")) return "cabane";
  return "cabane";
}

export const hikingRoute: FastifyPluginAsync = async (fastify) => {
  // Search trails by name
  fastify.get<{
    Querystring: { query: string; limit?: string };
  }>("/hiking/search", {
    schema: {
      querystring: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string" },
          limit: { type: "string" },
        },
      },
    },
    handler: async (req, reply) => {
      const { query } = req.query;
      const limit = Math.min(Number(req.query.limit ?? 20), 100);
      if (!query.trim()) {
        return reply.send([]);
      }
      const cacheKey = `cache:hiking:search:${query.toLowerCase().trim()}:${limit}`;
      try {
        const results = await withCache(cacheKey, TTL.hiking.search, () =>
          searchTrails(query, limit),
        );
        reply.header("Cache-Control", "public, max-age=300");
        return reply.send(results);
      } catch (error) {
        req.log.warn({ err: error }, "Hiking trail search failed");
        return reply.status(502).send({ message: "Trail search unavailable" });
      }
    },
  });

  // Trails in bounding box
  fastify.get<{
    Querystring: { south: string; west: string; north: string; east: string; limit?: string };
  }>("/hiking/area", {
    schema: {
      querystring: {
        type: "object",
        required: ["south", "west", "north", "east"],
        properties: {
          south: { type: "string" },
          west: { type: "string" },
          north: { type: "string" },
          east: { type: "string" },
          limit: { type: "string" },
        },
      },
    },
    handler: async (req, reply) => {
      const south = Number(req.query.south);
      const west = Number(req.query.west);
      const north = Number(req.query.north);
      const east = Number(req.query.east);
      const limit = Math.min(Number(req.query.limit ?? 50), 200);

      if ([south, west, north, east].some((v) => !Number.isFinite(v))) {
        return reply.status(400).send({ message: "Invalid bbox coordinates" });
      }
      if (north - south > MAX_BBOX_SPAN || east - west > MAX_BBOX_SPAN) {
        return reply.status(400).send({ message: "Bounding box too large" });
      }

      const rs = round(south, 2);
      const rw = round(west, 2);
      const rn = round(north, 2);
      const re = round(east, 2);
      const cacheKey = `cache:hiking:area:${rs},${rw},${rn},${re}:${limit}`;

      try {
        const results = await withCache(cacheKey, TTL.hiking.area, () =>
          trailsByArea(rs, rw, rn, re, limit),
        );
        reply.header("Cache-Control", "public, max-age=300");
        return reply.send(results);
      } catch (error) {
        req.log.warn({ err: error }, "Hiking area search failed");
        return reply.status(502).send({ message: "Trail area search unavailable" });
      }
    },
  });

  // Trail detail
  fastify.get<{
    Params: { id: string };
  }>("/hiking/details/:id", {
    schema: {
      params: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string", pattern: "^[0-9]+$" } },
      },
    },
    handler: async (req, reply) => {
      const id = Number(req.params.id);
      const cacheKey = `cache:hiking:detail:${id}`;

      try {
        const detail = await withCache(cacheKey, TTL.hiking.detail, () => trailDetail(id));
        reply.header("Cache-Control", "public, max-age=3600");
        return reply.send(detail);
      } catch (error) {
        req.log.warn({ err: error, id }, "Hiking trail detail failed");
        return reply.status(502).send({ message: "Trail detail unavailable" });
      }
    },
  });

  // Trail geometry (Overpass)
  fastify.get<{
    Params: { id: string };
  }>("/hiking/geometry/:id", {
    schema: {
      params: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string", pattern: "^[0-9]+$" } },
      },
    },
    handler: async (req, reply) => {
      const id = Number(req.params.id);
      const cacheKey = `cache:hiking:geom:${id}`;

      try {
        const geojson = await withCache(cacheKey, TTL.hiking.geometry, () =>
          fetchRouteGeometry(id),
        );
        reply.header("Cache-Control", "public, max-age=3600");
        return reply.send(geojson);
      } catch (error) {
        req.log.warn({ err: error, id }, "Hiking trail geometry failed");
        if (error instanceof OverpassRateLimitError) {
          return reply.status(429).send({ message: "Overpass rate limit exceeded" });
        }
        return reply.status(502).send({ message: "Trail geometry unavailable" });
      }
    },
  });

  // Mountain shelters (Refuges.info)
  fastify.get<{
    Querystring: { south: string; west: string; north: string; east: string; type?: string };
  }>("/hiking/shelters", {
    schema: {
      querystring: {
        type: "object",
        required: ["south", "west", "north", "east"],
        properties: {
          south: { type: "string" },
          west: { type: "string" },
          north: { type: "string" },
          east: { type: "string" },
          type: { type: "string" },
        },
      },
    },
    handler: async (req, reply) => {
      const south = Number(req.query.south);
      const west = Number(req.query.west);
      const north = Number(req.query.north);
      const east = Number(req.query.east);
      const typeFilter = req.query.type ?? "";

      if ([south, west, north, east].some((v) => !Number.isFinite(v))) {
        return reply.status(400).send({ message: "Invalid bbox coordinates" });
      }
      if (north - south > MAX_BBOX_SPAN || east - west > MAX_BBOX_SPAN) {
        return reply.status(400).send({ message: "Bounding box too large" });
      }

      const rs = round(south, 2);
      const rw = round(west, 2);
      const rn = round(north, 2);
      const re = round(east, 2);
      const cacheKey = `cache:hiking:shelters:${rs},${rw},${rn},${re}:${typeFilter}`;

      try {
        const bbox = `${rw},${rs},${re},${rn}`;
        let url = `https://www.refuges.info/api/bbox?bbox=${bbox}&format=geojson&detail=simple&nb_points=200`;
        if (typeFilter) {
          url += `&type_points=${encodeURIComponent(typeFilter)}`;
        }

        const result = await withCache(cacheKey, TTL.hiking.shelters, async () => {
          const res = await fetch(url, {
            headers: { "User-Agent": "OpenMapX/1.0 (+https://openmapx.org)" },
          });
          if (!res.ok) throw new Error(`Refuges.info returned ${res.status}`);
          const raw = (await res.json()) as {
            features: Array<{
              type: string;
              id: number;
              properties: {
                nom: string;
                type: { valeur: string } | string;
                coord: { alt: number };
                places: { valeur: number } | number;
              };
              geometry: { type: string; coordinates: [number, number] };
            }>;
          };
          return {
            type: "FeatureCollection",
            features: (raw.features ?? []).map((f) => {
              const propType = f.properties.type;
              const rawType =
                propType != null && typeof propType === "object"
                  ? ((propType as { valeur: string }).valeur ?? "")
                  : String(propType ?? "");
              const propPlaces = f.properties.places;
              const rawPlaces =
                propPlaces != null && typeof propPlaces === "object"
                  ? (propPlaces as { valeur: number }).valeur
                  : Number(propPlaces ?? 0);
              return {
                type: "Feature",
                geometry: f.geometry,
                properties: {
                  id: f.id,
                  name: f.properties.nom ?? "",
                  type: classifyShelterType(rawType),
                  altitude: f.properties.coord?.alt ?? null,
                  capacity: rawPlaces || null,
                },
              };
            }),
          };
        });

        reply.header("Cache-Control", "public, max-age=300");
        return reply.send(result);
      } catch (error) {
        req.log.warn({ err: error }, "Mountain shelter fetch failed");
        return reply.status(502).send({ message: "Shelter data unavailable" });
      }
    },
  });
};

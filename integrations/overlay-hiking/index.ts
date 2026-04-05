import type { IntegrationContext } from "@openmapx/core";
import { OverpassRateLimitError } from "@openmapx/core";
import { fetchRouteGeometry } from "./overpass-geometry.js";
import { searchTrails, trailDetail, trailsByArea } from "./waymarked-trails.js";

const MAX_BBOX_SPAN = 1.0;
const CACHE_TTL_SHORT = 300;
const CACHE_TTL_LONG = 3600;

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

function round(n: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

export function setup(ctx: IntegrationContext): void {
  ctx.registerRoute("GET", "/tiles/:z/:x/:y.png", async (req, reply) => {
    const z = Number(req.params.z);
    const x = Number(req.params.x);
    const y = Number(req.params.y);
    if (![z, x, y].every((v) => Number.isFinite(v) && v >= 0)) {
      reply.status(400).send({ message: "Invalid tile coordinates" });
      return;
    }

    const baseUrl =
      process.env.WAYMARKED_HIKING_TILE_URL ??
      "https://tile.waymarkedtrails.org/hiking/{z}/{x}/{y}.png";
    const url = baseUrl
      .replace("{z}", String(z))
      .replace("{x}", String(x))
      .replace("{y}", String(y));

    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "OpenMapX/1.0 (+https://openmapx.org)" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        reply.status(response.status).send({ message: "Upstream tile fetch failed" });
        return;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      reply.header("Cache-Control", "public, max-age=604800, s-maxage=604800");
      reply.type("image/png");
      reply.send(buffer);
    } catch (err) {
      ctx.log.warn({ err, z, x, y }, "Hiking tile fetch failed");
      reply.status(502).send({ message: "Hiking tile provider unavailable" });
    }
  });

  ctx.registerRoute("GET", "/hiking/search", async (req, reply) => {
    const query = req.query.query ?? "";
    const limit = Math.min(Number(req.query.limit ?? 20), 100);
    if (!query.trim()) {
      reply.send([]);
      return;
    }
    const cacheKey = `search:${query.toLowerCase().trim()}:${limit}`;
    try {
      const cached = await ctx.cache.get(cacheKey);
      if (cached) {
        reply.send(cached);
        return;
      }
      const results = await searchTrails(query, limit);
      await ctx.cache.set(cacheKey, results, CACHE_TTL_SHORT);
      reply.send(results);
    } catch (err) {
      ctx.log.warn("Hiking trail search failed", err);
      reply.status(502).send({ message: "Trail search unavailable" });
    }
  });

  ctx.registerRoute("GET", "/hiking/area", async (req, reply) => {
    const south = Number(req.query.south);
    const west = Number(req.query.west);
    const north = Number(req.query.north);
    const east = Number(req.query.east);
    const limit = Math.min(Number(req.query.limit ?? 50), 200);

    if ([south, west, north, east].some((v) => !Number.isFinite(v))) {
      reply.status(400).send({ message: "Invalid bbox coordinates" });
      return;
    }
    if (north - south > MAX_BBOX_SPAN || east - west > MAX_BBOX_SPAN) {
      reply.status(400).send({ message: "Bounding box too large" });
      return;
    }

    const rs = round(south, 2);
    const rw = round(west, 2);
    const rn = round(north, 2);
    const re = round(east, 2);
    const cacheKey = `area:${rs},${rw},${rn},${re}:${limit}`;

    try {
      const cached = await ctx.cache.get(cacheKey);
      if (cached) {
        reply.send(cached);
        return;
      }
      const results = await trailsByArea(rs, rw, rn, re, limit);
      await ctx.cache.set(cacheKey, results, CACHE_TTL_SHORT);
      reply.send(results);
    } catch (err) {
      ctx.log.warn("Hiking area search failed", err);
      reply.status(502).send({ message: "Trail area search unavailable" });
    }
  });

  ctx.registerRoute("GET", "/hiking/details/:id", async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      reply.status(400).send({ message: "Invalid trail ID" });
      return;
    }
    const cacheKey = `detail:${id}`;
    try {
      const cached = await ctx.cache.get(cacheKey);
      if (cached) {
        reply.send(cached);
        return;
      }
      const detail = await trailDetail(id);
      await ctx.cache.set(cacheKey, detail, CACHE_TTL_LONG);
      reply.send(detail);
    } catch (err) {
      ctx.log.warn("Hiking trail detail failed", err);
      reply.status(502).send({ message: "Trail detail unavailable" });
    }
  });

  ctx.registerRoute("GET", "/hiking/geometry/:id", async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      reply.status(400).send({ message: "Invalid trail ID" });
      return;
    }
    const cacheKey = `geom:${id}`;
    try {
      const cached = await ctx.cache.get(cacheKey);
      if (cached) {
        reply.send(cached);
        return;
      }
      const geojson = await fetchRouteGeometry(id);
      await ctx.cache.set(cacheKey, geojson, CACHE_TTL_LONG);
      reply.send(geojson);
    } catch (err) {
      ctx.log.warn("Hiking trail geometry failed", err);
      if (err instanceof OverpassRateLimitError) {
        reply.status(429).send({ message: "Overpass rate limit exceeded" });
        return;
      }
      reply.status(502).send({ message: "Trail geometry unavailable" });
    }
  });

  ctx.registerRoute("GET", "/hiking/shelters", async (req, reply) => {
    const south = Number(req.query.south);
    const west = Number(req.query.west);
    const north = Number(req.query.north);
    const east = Number(req.query.east);
    const typeFilter = req.query.type ?? "";

    if ([south, west, north, east].some((v) => !Number.isFinite(v))) {
      reply.status(400).send({ message: "Invalid bbox coordinates" });
      return;
    }
    if (north - south > MAX_BBOX_SPAN || east - west > MAX_BBOX_SPAN) {
      reply.status(400).send({ message: "Bounding box too large" });
      return;
    }

    const rs = round(south, 2);
    const rw = round(west, 2);
    const rn = round(north, 2);
    const re = round(east, 2);
    const cacheKey = `shelters:${rs},${rw},${rn},${re}:${typeFilter}`;

    try {
      const cached = await ctx.cache.get(cacheKey);
      if (cached) {
        reply.send(cached);
        return;
      }

      const bbox = `${rw},${rs},${re},${rn}`;
      let url = `https://www.refuges.info/api/bbox?bbox=${bbox}&format=geojson&detail=simple&nb_points=200`;
      if (typeFilter) {
        url += `&type_points=${encodeURIComponent(typeFilter)}`;
      }

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

      const result = {
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

      await ctx.cache.set(cacheKey, result, CACHE_TTL_SHORT);
      reply.send(result);
    } catch (err) {
      ctx.log.warn("Mountain shelter fetch failed", err);
      reply.status(502).send({ message: "Shelter data unavailable" });
    }
  });
}

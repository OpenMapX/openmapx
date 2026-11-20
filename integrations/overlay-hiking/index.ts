import { bboxCacheKey, fetchJson, OverpassRateLimitError } from "@openmapx/core";
import {
  captureCacheWriter,
  dataSourceToAttribution,
  type IntegrationContext,
  scalarQueries,
  serializeContributors,
} from "@openmapx/integration-framework";
import { createTileProxyHandler } from "@openmapx/integration-framework/tile-proxy";
import { fetchRouteGeometry } from "./overpass-geometry.js";
import { searchTrails, trailDetail, trailsByArea } from "./waymarked-trails.js";

const MAX_BBOX_SPAN = 1.0;
const CACHE_TTL_SHORT = 300;
const CACHE_TTL_LONG = 3600;

import manifest from "./manifest.json";

export function classifyShelterType(rawType: string): string {
  const t = rawType.toLowerCase();
  if (t.includes("cabane") || t.includes("bivouac") || t.includes("abri")) return "cabane";
  if (t.includes("refuge") || t.includes("gardé")) return "refuge";
  if (t.includes("gîte") || t.includes("gite")) return "gite";
  if (t.includes("eau") || t.includes("water") || t.includes("source")) return "pt_eau";
  if (t.includes("passage") || t.includes("col") || t.includes("pass")) return "pt_passage";
  if (t.includes("hut") || t.includes("shelter")) return "cabane";
  return "cabane";
}

export function setup(ctx: IntegrationContext): void {
  const tileUrl =
    (ctx.config.tileUrl as string | undefined) ??
    "https://tile.waymarkedtrails.org/hiking/{z}/{x}/{y}.png";

  ctx.registerRoute(
    "GET",
    "/tiles/:z/:x/:y.png",
    createTileProxyHandler(ctx, {
      kind: "raster",
      label: "Waymarked Trails tile",
      url: ({ z, x, y }) =>
        tileUrl.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y)),
      maxZoom: 18,
      fallbackContentType: "image/png",
      cacheControl: "public, max-age=604800, s-maxage=604800",
    }),
    { rateLimitTier: "tile" },
  );

  ctx.registerRoute("GET", "/hiking/search", async (req, reply) => {
    const query = scalarQueries(req.query).query ?? "";
    const limit = Math.min(Number(scalarQueries(req.query).limit ?? 20), 100);
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
      const writer = await captureCacheWriter(ctx.cache);
      const results = await searchTrails(query, limit);
      await writer.set(cacheKey, results, CACHE_TTL_SHORT);
      reply.send(results);
    } catch (err) {
      ctx.log.warn("Hiking trail search failed", err);
      reply.status(502).send({ error: "Trail search unavailable" });
    }
  });

  ctx.registerRoute("GET", "/hiking/area", async (req, reply) => {
    const south = Number(scalarQueries(req.query).south);
    const west = Number(scalarQueries(req.query).west);
    const north = Number(scalarQueries(req.query).north);
    const east = Number(scalarQueries(req.query).east);
    const limit = Math.min(Number(scalarQueries(req.query).limit ?? 50), 200);

    if ([south, west, north, east].some((v) => !Number.isFinite(v))) {
      reply.status(400).send({ error: "Invalid bbox coordinates" });
      return;
    }
    if (north - south > MAX_BBOX_SPAN || east - west > MAX_BBOX_SPAN) {
      reply.status(400).send({ error: "Bounding box too large" });
      return;
    }

    const cacheKey = `area:${bboxCacheKey({ south, west, north, east })}:${limit}`;

    try {
      const cached = await ctx.cache.get(cacheKey);
      if (cached) {
        reply.send(cached);
        return;
      }
      const writer = await captureCacheWriter(ctx.cache);
      const results = await trailsByArea(south, west, north, east, limit);
      await writer.set(cacheKey, results, CACHE_TTL_SHORT);
      reply.send(results);
    } catch (err) {
      ctx.log.warn("Hiking area search failed", err);
      reply.status(502).send({ error: "Trail area search unavailable" });
    }
  });

  ctx.registerRoute("GET", "/hiking/details/:id", async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      reply.status(400).send({ error: "Invalid trail ID" });
      return;
    }
    const cacheKey = `detail:${id}`;
    try {
      const cached = await ctx.cache.get(cacheKey);
      if (cached) {
        reply.send(cached);
        return;
      }
      const writer = await captureCacheWriter(ctx.cache);
      const detail = await trailDetail(id);
      await writer.set(cacheKey, detail, CACHE_TTL_LONG);
      reply.send(detail);
    } catch (err) {
      ctx.log.warn("Hiking trail detail failed", err);
      reply.status(502).send({ error: "Trail detail unavailable" });
    }
  });

  ctx.registerRoute("GET", "/hiking/geometry/:id", async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      reply.status(400).send({ error: "Invalid trail ID" });
      return;
    }
    const cacheKey = `geom:${id}`;
    try {
      const cached = await ctx.cache.get(cacheKey);
      if (cached) {
        reply.send(cached);
        return;
      }
      const writer = await captureCacheWriter(ctx.cache);
      const geojson = await fetchRouteGeometry(id);
      await writer.set(cacheKey, geojson, CACHE_TTL_LONG);
      reply.send(geojson);
    } catch (err) {
      ctx.log.warn("Hiking trail geometry failed", err);
      if (err instanceof OverpassRateLimitError) {
        reply.status(429).send({ error: "Overpass rate limit exceeded" });
        return;
      }
      reply.status(502).send({ error: "Trail geometry unavailable" });
    }
  });

  ctx.registerRoute("GET", "/hiking/shelters", async (req, reply) => {
    const south = Number(scalarQueries(req.query).south);
    const west = Number(scalarQueries(req.query).west);
    const north = Number(scalarQueries(req.query).north);
    const east = Number(scalarQueries(req.query).east);
    const typeFilter = scalarQueries(req.query).type ?? "";

    if ([south, west, north, east].some((v) => !Number.isFinite(v))) {
      reply.status(400).send({ error: "Invalid bbox coordinates" });
      return;
    }
    if (north - south > MAX_BBOX_SPAN || east - west > MAX_BBOX_SPAN) {
      reply.status(400).send({ error: "Bounding box too large" });
      return;
    }

    const cacheKey = `shelters:contributors-v1:${bboxCacheKey({ south, west, north, east })}:${typeFilter}`;

    try {
      const cached = await ctx.cache.get(cacheKey);
      if (cached) {
        reply.send(cached);
        return;
      }
      const writer = await captureCacheWriter(ctx.cache);

      const bbox = `${west},${south},${east},${north}`;
      let url = `https://www.refuges.info/api/bbox?bbox=${bbox}&format=geojson&detail=simple&nb_points=200`;
      if (typeFilter) {
        url += `&type_points=${encodeURIComponent(typeFilter)}`;
      }

      const raw = await fetchJson<{
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
      }>(url, {
        errorMessage: ({ status }) => `Refuges.info returned ${status}`,
      });

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
              _mapAttributions: serializeContributors(
                manifest.dataSources
                  .filter((s) => s.sourceId === "refuges-info")
                  .map(dataSourceToAttribution),
              ),
              name: f.properties.nom ?? "",
              type: classifyShelterType(rawType),
              altitude: f.properties.coord?.alt ?? null,
              capacity: rawPlaces || null,
            },
          };
        }),
      };

      await writer.set(cacheKey, result, CACHE_TTL_SHORT);
      reply.send(result);
    } catch (err) {
      ctx.log.warn("Mountain shelter fetch failed", err);
      reply.status(502).send({ error: "Shelter data unavailable" });
    }
  });
}

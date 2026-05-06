import type { IntegrationContext } from "@openmapx/core";
import { getPhotoProviders, resolveOsmTags, searchPhotos } from "./orchestrator.js";

export function setup(ctx: IntegrationContext): void {
  ctx.registerRoute("GET", "/search", async (req, reply) => {
    const lat = Number.parseFloat(req.query.lat);
    const lng = Number.parseFloat(req.query.lng);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      reply.status(400).send({ error: "Invalid coordinates" });
      return;
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      reply.status(400).send({ error: "Coordinates out of range" });
      return;
    }

    const limit = Math.min(Number.parseInt(req.query.limit ?? "20", 10) || 20, 50);
    const name = req.query.name?.trim();
    const placeId = req.query.placeId?.trim();

    const nameKey = name ? `:${name.slice(0, 40)}` : "";
    const placeKey = placeId ? `:${placeId.slice(0, 40)}` : "";
    const cacheKey = `cache:photos:${lat.toFixed(4)}:${lng.toFixed(4)}:${limit}${nameKey}${placeKey}`;

    try {
      const photos = await ctx.cache.withCache(cacheKey, 3600, async () => {
        // If placeId is provided, resolve OSM tags for tag-based photo lookups
        let osmTags: Record<string, string> | undefined;
        if (placeId) {
          osmTags = await resolveOsmTags(placeId, name, lat, lng);
        }
        const providers = getPhotoProviders(ctx.getIntegrationsByDomain("photos"));
        return searchPhotos({ lat, lng, name, limit, osmTags }, providers);
      });

      reply.header("Cache-Control", "public, max-age=3600");
      reply.send({ photos });
    } catch (err) {
      ctx.log.error("Photo search failed", err);
      reply.status(500).send({ error: "Photo search failed" });
    }
  });
}

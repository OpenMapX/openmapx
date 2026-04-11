import type { IntegrationContext } from "@openmapx/core";
import { OverpassTimeoutError } from "@openmapx/core";
import { createPoiSearchOrchestrator } from "./orchestrator.js";

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function setup(ctx: IntegrationContext): void {
  const orchestrator = createPoiSearchOrchestrator(ctx);

  ctx.registerRoute("GET", "/search", async (req, reply) => {
    const { category, south, west, north, east, lang } = req.query;

    const bbox = {
      south: Number.parseFloat(south),
      west: Number.parseFloat(west),
      north: Number.parseFloat(north),
      east: Number.parseFloat(east),
    };

    for (const [key, val] of Object.entries(bbox)) {
      if (!Number.isFinite(val)) {
        reply.status(400).send({ error: `Invalid bbox parameter: ${key}` });
        return;
      }
    }

    const bboxRounded = {
      east: round(bbox.east, 2),
      north: round(bbox.north, 2),
      south: round(bbox.south, 2),
      west: round(bbox.west, 2),
    };
    const cacheKey = `category:${category}:${bboxRounded.south},${bboxRounded.west},${bboxRounded.north},${bboxRounded.east}`;

    try {
      const result = await ctx.cache.withCache(cacheKey, 300, () =>
        orchestrator.search(category, bbox, { lang }),
      );
      reply.header("Cache-Control", "public, max-age=300");
      reply.send(result);
    } catch (err) {
      if (err instanceof OverpassTimeoutError) {
        reply.status(422).send({ error: "area_too_large" });
        return;
      }
      const e = err as { statusCode?: number; message: string };
      if (e.statusCode === 400) {
        reply.status(400).send({ error: e.message });
        return;
      }
      throw err;
    }
  });
}

import type { BBox } from "@openmapx/core";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { eventsToFeatureCollection } from "./eventsToGeojson.js";
import { aggregateRoadConditions } from "./orchestrator.js";
import type { RoadConditionSeverity, RoadConditionType } from "./types.js";

function parseBbox(raw: string | undefined): BBox | null {
  if (!raw) return null;
  const parts = raw.split(",").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  return parts as BBox;
}

function bboxKey(bbox: BBox): string {
  return bbox.map((n) => n.toFixed(4)).join(",");
}

export function setup(ctx: IntegrationContext): void {
  // GET /events?bbox=west,south,east,north[&types=&minSeverity=]
  // Aggregates every enabled road-conditions provider into one GeoJSON
  // FeatureCollection — consumed by both the map overlay and navigation.
  ctx.registerRoute("GET", "/events", async (req, reply) => {
    const bbox = parseBbox(req.query.bbox);
    if (!bbox) {
      reply.status(400).send({ error: "bbox required: west,south,east,north" });
      return;
    }

    const types = (req.query.types ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean) as RoadConditionType[];
    const minSeverity = (req.query.minSeverity || undefined) as RoadConditionSeverity | undefined;

    const key = `conditions:query:roads:${bboxKey(bbox)}:${types.join("+")}:${minSeverity ?? ""}`;

    try {
      const fc = await ctx.cache.withCache(key, 90, async () => {
        const events = await aggregateRoadConditions(ctx, bbox, {
          types: types.length > 0 ? types : undefined,
          minSeverity,
        });
        return eventsToFeatureCollection(events);
      });
      reply.header("Cache-Control", "public, max-age=90, s-maxage=90");
      reply.send(fc);
    } catch (err) {
      ctx.log.error("road-conditions aggregation failed", err);
      reply.header("Cache-Control", "no-cache");
      reply.send({ type: "FeatureCollection", features: [] });
    }
  });
}

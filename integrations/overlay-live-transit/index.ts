import type { BBox } from "@openmapx/core";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { createLiveTransitOrchestrator } from "./orchestrator.js";

function parseBbox(query: Record<string, string>): BBox | null {
  const south = Number(query.south);
  const west = Number(query.west);
  const north = Number(query.north);
  const east = Number(query.east);

  if (
    !Number.isFinite(south) ||
    !Number.isFinite(west) ||
    !Number.isFinite(north) ||
    !Number.isFinite(east) ||
    south >= north ||
    west >= east
  ) {
    return null;
  }

  return [west, south, east, north];
}

function roundCoord(n: number): string {
  return (Math.round(n * 1000) / 1000).toFixed(3);
}

function bboxKey(bbox: BBox): string {
  return bbox.map(roundCoord).join(",");
}

export function setup(ctx: IntegrationContext): void {
  const orchestrator = createLiveTransitOrchestrator(ctx);

  ctx.registerRoute("GET", "/snapshot", async (req, reply) => {
    const bbox = parseBbox(req.query);
    if (!bbox) {
      reply.status(400).send({ error: "Invalid bbox coordinates" });
      return;
    }

    const baseKey = `live-transit:${bboxKey(bbox)}`;
    const [vehicles, alerts] = await Promise.all([
      ctx.cache.withCache(`${baseKey}:vehicles`, 15, () => orchestrator.getVehicles(bbox)),
      ctx.cache.withCache(`${baseKey}:alerts`, 60, () => orchestrator.getAlerts(bbox)),
    ]);

    reply.header("Cache-Control", "public, max-age=15, s-maxage=15");
    reply.send({ vehicles, alerts });
  });
}

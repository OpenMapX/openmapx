import { createHash } from "node:crypto";
import type { IntegrationContext, TravelMode } from "@openmapx/core";
import { createRoutingOrchestrator } from "./orchestrator.js";

/** Round a number to a fixed number of decimal places. */
function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Build a short hash key from a prefix + arbitrary data. */
function hashKey(prefix: string, data: unknown): string {
  const hash = createHash("sha256").update(JSON.stringify(data)).digest("hex").slice(0, 16);
  return `${prefix}:${hash}`;
}

/** Parse semicolon-separated "lng,lat" pairs into coordinate tuples. */
function parseWaypoints(raw: string): [number, number][] {
  return raw.split(";").map((pair) => {
    const [lng, lat] = pair.split(",").map(Number);
    if (Number.isNaN(lng) || Number.isNaN(lat)) {
      throw new Error(`Invalid coordinate pair: "${pair}"`);
    }
    return [lng, lat] as [number, number];
  });
}

/** Round all waypoints for cache-key stability. */
function roundWaypoints(wps: [number, number][]): [number, number][] {
  return wps.map((wp) => [round(wp[0], 4), round(wp[1], 4)]);
}

export function setup(ctx: IntegrationContext): void {
  const { getRoutingProvider, getOptimizeProvider } = createRoutingOrchestrator(ctx);

  ctx.registerRoute("GET", "/directions", async (req, reply) => {
    const {
      waypoints: waypointsParam,
      originLng,
      originLat,
      destLng,
      destLat,
      mode = "driving",
      avoidHighways,
      avoidTolls,
      avoidFerries,
      units,
      lang,
    } = req.query;

    let waypoints: [number, number][];

    if (waypointsParam) {
      try {
        waypoints = parseWaypoints(waypointsParam);
      } catch (e) {
        reply.status(400).send({ error: (e as Error).message });
        return;
      }
    } else if (originLng && originLat && destLng && destLat) {
      waypoints = [
        [Number(originLng), Number(originLat)],
        [Number(destLng), Number(destLat)],
      ];
    } else {
      reply.status(400).send({
        error:
          "Provide either 'waypoints' (semicolon-separated lng,lat pairs) or originLng/originLat/destLng/destLat",
      });
      return;
    }

    if (waypoints.length < 2) {
      reply.status(400).send({ error: "At least 2 waypoints are required" });
      return;
    }

    if (mode === "transit") {
      reply.status(400).send({ error: "Use /api/transit/plan for transit routing" });
      return;
    }

    const opts = {
      avoidHighways: avoidHighways === "true",
      avoidTolls: avoidTolls === "true",
      avoidFerries: avoidFerries === "true",
      units: (units ?? "metric") as "metric" | "imperial",
    };

    const keyParams = {
      avoidFerries: opts.avoidFerries,
      avoidHighways: opts.avoidHighways,
      avoidTolls: opts.avoidTolls,
      lang: lang ?? "en",
      mode,
      units: opts.units,
      waypoints: roundWaypoints(waypoints),
    };

    const travelMode = mode as TravelMode;
    const resolved = getRoutingProvider(travelMode);
    if (!resolved) {
      reply.status(503).send({ error: `No routing provider available for mode: ${mode}` });
      return;
    }

    const routingOpts = { ...opts, lang };

    try {
      const result = await ctx.cache.withCache(
        hashKey("cache:directions", keyParams),
        3600,
        async () => {
          const r = await resolved.provider.getRoute(waypoints, travelMode, routingOpts);
          r.provider = resolved.integrationId;
          return r;
        },
      );
      reply.header("Cache-Control", "public, max-age=3600");
      reply.send(result);
    } catch {
      reply.status(502).send({ error: "Routing unavailable" });
    }
  });

  ctx.registerRoute("GET", "/directions/optimize", async (req, reply) => {
    const {
      waypoints: waypointsParam,
      originLng,
      originLat,
      destLng,
      destLat,
      mode = "driving",
      avoidHighways,
      avoidTolls,
      avoidFerries,
      units,
      lang,
    } = req.query;

    let waypoints: [number, number][];

    if (waypointsParam) {
      try {
        waypoints = parseWaypoints(waypointsParam);
      } catch (e) {
        reply.status(400).send({ error: (e as Error).message });
        return;
      }
    } else if (originLng && originLat && destLng && destLat) {
      waypoints = [
        [Number(originLng), Number(originLat)],
        [Number(destLng), Number(destLat)],
      ];
    } else {
      reply.status(400).send({
        error:
          "Provide either 'waypoints' (semicolon-separated lng,lat pairs) or originLng/originLat/destLng/destLat",
      });
      return;
    }

    if (waypoints.length < 3) {
      reply.status(400).send({ error: "At least 3 waypoints are required for optimization" });
      return;
    }

    const opts = {
      avoidHighways: avoidHighways === "true",
      avoidTolls: avoidTolls === "true",
      avoidFerries: avoidFerries === "true",
      units: (units ?? "metric") as "metric" | "imperial",
    };

    const keyParams = {
      avoidFerries: opts.avoidFerries,
      avoidHighways: opts.avoidHighways,
      avoidTolls: opts.avoidTolls,
      lang: lang ?? "en",
      mode,
      optimize: true,
      units: opts.units,
      waypoints: roundWaypoints(waypoints),
    };

    const travelMode = mode as TravelMode;
    const resolved = getOptimizeProvider(travelMode);
    const optimizeFn = resolved?.provider.optimizeRoute;
    if (!resolved || !optimizeFn) {
      reply.status(503).send({ error: `No optimize provider available for mode: ${mode}` });
      return;
    }

    const routingOpts = { ...opts, lang };

    try {
      const result = await ctx.cache.withCache(
        hashKey("cache:directions:optimize", keyParams),
        3600,
        async () => {
          const r = await optimizeFn(waypoints, travelMode, routingOpts);
          r.provider = resolved.integrationId;
          return r;
        },
      );
      reply.header("Cache-Control", "public, max-age=3600");
      reply.send(result);
    } catch {
      reply.status(502).send({ error: "Route optimization unavailable" });
    }
  });
}

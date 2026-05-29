import type { AirportType } from "@openmapx/core";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { queryAirportsInBbox, startBackgroundLoad } from "@openmapx/ourairports-data";

const DEFAULT_BBOX_LIMIT = 1500;
const MAX_BBOX_LIMIT = 5000;

/** Bbox cache TTL — the airport catalog refreshes every 24 h. */
const CACHE_TTL_SECONDS = 24 * 60 * 60;

const VALID_TYPES = new Set<AirportType>([
  "large_airport",
  "medium_airport",
  "small_airport",
  "heliport",
  "seaplane_base",
  "balloonport",
  "closed_airport",
]);

interface AirportFeatureProperties {
  id: number;
  ident: string;
  name: string;
  type: AirportType;
  iata?: string;
  icao?: string;
  scheduledService: boolean;
  elevationFt?: number;
  municipality?: string;
  isoCountry?: string;
  /** Importance rank (0 = large, 6 = closed) — exposed so the map style can
   * zoom-filter and size markers without re-deriving it client-side. */
  rank: number;
}

interface AirportFeature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: AirportFeatureProperties;
}

interface AirportFeatureCollection {
  type: "FeatureCollection";
  features: AirportFeature[];
}

const TYPE_RANK: Record<AirportType, number> = {
  large_airport: 0,
  medium_airport: 1,
  small_airport: 2,
  seaplane_base: 3,
  heliport: 4,
  balloonport: 5,
  closed_airport: 6,
};

/** 4-decimal precision (~11 m) so adjacent viewports share a cache slot. */
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function parseBbox(
  q: Record<string, string>,
): { west: number; south: number; east: number; north: number } | { error: string } {
  const west = Number.parseFloat(q.west ?? "");
  const south = Number.parseFloat(q.south ?? "");
  const east = Number.parseFloat(q.east ?? "");
  const north = Number.parseFloat(q.north ?? "");
  if (
    !Number.isFinite(west) ||
    !Number.isFinite(south) ||
    !Number.isFinite(east) ||
    !Number.isFinite(north)
  ) {
    return { error: "west/south/east/north must be valid numbers" };
  }
  if (south < -90 || north > 90 || south > north) {
    return { error: "Invalid south/north range" };
  }
  return { west, south, east, north };
}

function parseTypes(raw: string | undefined): AirportType[] | undefined {
  if (!raw) return undefined;
  const list = raw
    .split(",")
    .map((s) => s.trim() as AirportType)
    .filter((s) => VALID_TYPES.has(s));
  return list.length > 0 ? list : undefined;
}

export function setup(ctx: IntegrationContext): void {
  // Start loading the airport catalog in the background. The shared package
  // dedupes against any other integration (knowledge-ourairports) that may
  // already have started a load.
  startBackgroundLoad(ctx.log);

  ctx.registerRoute("GET", "/airports", async (req, reply) => {
    const bbox = parseBbox(req.query);
    if ("error" in bbox) {
      reply.status(400).send({ message: bbox.error });
      return;
    }

    const types = parseTypes(req.query.types);
    const scheduledOnly = req.query.scheduledOnly === "1";
    const limitParam = Number.parseInt(req.query.limit ?? "", 10);
    const limit =
      Number.isFinite(limitParam) && limitParam > 0
        ? Math.min(limitParam, MAX_BBOX_LIMIT)
        : DEFAULT_BBOX_LIMIT;

    const cacheKey = [
      "bbox",
      round4(bbox.west),
      round4(bbox.south),
      round4(bbox.east),
      round4(bbox.north),
      types?.join("|") ?? "*",
      scheduledOnly ? "sched" : "all",
      limit,
    ].join(":");

    const collection = await ctx.cache.withCache(cacheKey, CACHE_TTL_SECONDS, async () => {
      const records = await queryAirportsInBbox(ctx.log, {
        ...bbox,
        types,
        scheduledOnly,
        limit,
      });

      const featureCollection: AirportFeatureCollection = {
        type: "FeatureCollection",
        features: records.map((r) => ({
          type: "Feature",
          geometry: { type: "Point", coordinates: [r.lng, r.lat] },
          properties: {
            id: r.id,
            ident: r.ident,
            name: r.name,
            type: r.type,
            iata: r.iata,
            icao: r.icao,
            scheduledService: r.scheduledService,
            elevationFt: r.elevationFt,
            municipality: r.municipality,
            isoCountry: r.isoCountry,
            rank: TYPE_RANK[r.type] ?? 99,
          },
        })),
      };
      return featureCollection;
    });
    reply.header("Cache-Control", "public, max-age=3600");
    reply.send(collection);
  });
}

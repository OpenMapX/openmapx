import { USER_AGENT } from "@openmapx/core";
import { envString } from "@openmapx/core/server-env";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import {
  encodeRasterContributors,
  RASTER_CONTRIBUTORS_HEADER,
  readRasterResponseBytes,
} from "@openmapx/mobility-core/raster-contributors";
import type { FastifyPluginAsync } from "fastify";
import { declareRouteAuth } from "../utils/route-auth.js";

const OSM_ATTRIBUTION: Attribution = {
  sourceId: "openstreetmap",
  name: "© OpenStreetMap contributors",
  url: "https://www.openstreetmap.org/copyright",
  spdxLicense: "ODbL-1.0",
  licenseUrl: "https://opendatacommons.org/licenses/odbl/",
};
const CYCLOSM_ATTRIBUTIONS: Attribution[] = [
  {
    sourceId: "cyclosm",
    name: "CyclOSM",
    url: "https://www.cyclosm.org/",
    publisher: { name: "OpenStreetMap France", url: "https://openstreetmap.fr/" },
  },
  OSM_ATTRIBUTION,
];
const THUNDERFOREST_ATTRIBUTIONS: Attribution[] = [
  {
    sourceId: "thunderforest",
    name: "Maps © Thunderforest",
    url: "https://www.thunderforest.com/maps/opencyclemap/",
  },
  OSM_ATTRIBUTION,
];

const CYCLOSM_SUBDOMAINS = ["a", "b", "c"] as const;
let cyclOSMSubdomainIndex = 0;

function nextCyclOSMSubdomain(): string {
  const sub = CYCLOSM_SUBDOMAINS[cyclOSMSubdomainIndex % CYCLOSM_SUBDOMAINS.length];
  cyclOSMSubdomainIndex++;
  return sub;
}

const THUNDERFOREST_SUBDOMAINS = ["a", "b", "c"] as const;
let thunderforestSubdomainIndex = 0;

function nextThunderforestSubdomain(): string {
  const sub =
    THUNDERFOREST_SUBDOMAINS[thunderforestSubdomainIndex % THUNDERFOREST_SUBDOMAINS.length];
  thunderforestSubdomainIndex++;
  return sub;
}

const TILE_PARAMS_SCHEMA = {
  type: "object" as const,
  required: ["z", "x", "y"],
  properties: {
    z: { type: "string" as const, pattern: "^[0-9]{1,2}$" },
    x: { type: "string" as const, pattern: "^[0-9]+$" },
    y: { type: "string" as const, pattern: "^[0-9]+$" },
  },
};

function validateTileCoords(z: string, x: string, y: string): [number, number, number] | null {
  const zn = Number(z);
  const xn = Number(x);
  const yn = Number(y);
  if (![zn, xn, yn].every((v) => Number.isFinite(v) && v >= 0)) return null;
  return [zn, xn, yn];
}

export const tilesRoute: FastifyPluginAsync = async (fastify) => {
  declareRouteAuth(fastify, "public");

  // Cycling base layer tile proxy (Thunderforest primary, CyclOSM fallback)
  fastify.get<{
    Params: { z: string; x: string; y: string };
  }>("/tiles/cyclosm/:z/:x/:y.png", {
    schema: { params: TILE_PARAMS_SCHEMA },
    handler: async (req, reply) => {
      const coords = validateTileCoords(req.params.z, req.params.x, req.params.y);
      if (!coords) {
        return reply.status(400).send({ message: "Invalid tile coordinates" });
      }
      const [z, x, y] = coords;

      // Capture complete notices before either asynchronous acquisition. The
      // chosen header travels with these successful bytes through HTTP caches.
      const primaryReceipt = encodeRasterContributors(THUNDERFOREST_ATTRIBUTIONS);
      const fallbackReceipt = encodeRasterContributors(CYCLOSM_ATTRIBUTIONS);
      const thunderforestKey = process.env.THUNDERFOREST_API_KEY;
      if (thunderforestKey) {
        const tfSub = nextThunderforestSubdomain();
        const tfUrl = `https://${tfSub}.tile.thunderforest.com/cycle/${z}/${x}/${y}.png?apikey=${thunderforestKey}`;

        try {
          const tfResponse = await fetch(tfUrl, {
            headers: { "User-Agent": USER_AGENT },
            signal: AbortSignal.timeout(10_000),
          });

          if (!tfResponse.ok) {
            throw new Error(`Thunderforest returned ${tfResponse.status}`);
          }

          const tfBuffer = Buffer.from(await readRasterResponseBytes(tfResponse));
          reply.header("Cache-Control", "public, max-age=604800, s-maxage=604800");
          reply.header("Cross-Origin-Resource-Policy", "cross-origin");
          reply.header("X-Tile-Source", "thunderforest");
          reply.header(RASTER_CONTRIBUTORS_HEADER, primaryReceipt);
          reply.header(
            "Access-Control-Expose-Headers",
            [reply.getHeader("Access-Control-Expose-Headers"), RASTER_CONTRIBUTORS_HEADER]
              .filter(Boolean)
              .join(", "),
          );
          reply.type("image/png");
          return reply.send(tfBuffer);
        } catch (error) {
          req.log.warn({ err: error, z, x, y }, "Thunderforest tile fetch failed");
        }
      }

      const baseUrl = envString(
        "CYCLOSM_TILE_URL",
        "https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png",
      );

      const sub = nextCyclOSMSubdomain();
      const url = baseUrl
        .replace("{s}", sub)
        .replace("{z}", String(z))
        .replace("{x}", String(x))
        .replace("{y}", String(y));

      try {
        const response = await fetch(url, {
          headers: { "User-Agent": USER_AGENT },
          signal: AbortSignal.timeout(10_000),
        });

        if (!response.ok) {
          return reply.status(response.status).send({ message: "Upstream tile fetch failed" });
        }

        const buffer = Buffer.from(await readRasterResponseBytes(response));
        reply.header("Cache-Control", "public, max-age=604800, s-maxage=604800");
        reply.header("Cross-Origin-Resource-Policy", "cross-origin");
        reply.header("X-Tile-Source", "cyclosm");
        reply.header(RASTER_CONTRIBUTORS_HEADER, fallbackReceipt);
        reply.header(
          "Access-Control-Expose-Headers",
          [reply.getHeader("Access-Control-Expose-Headers"), RASTER_CONTRIBUTORS_HEADER]
            .filter(Boolean)
            .join(", "),
        );
        reply.type("image/png");
        return reply.send(buffer);
      } catch (error) {
        req.log.warn({ err: error, z, x, y }, "CyclOSM fallback tile fetch failed");
        return reply.status(502).send({ message: "All cycling tile providers unavailable" });
      }
    },
  });

  // Waymarked Trails cycling routes tile proxy
  fastify.get<{
    Params: { z: string; x: string; y: string };
  }>("/tiles/cycling-routes/:z/:x/:y.png", {
    schema: { params: TILE_PARAMS_SCHEMA },
    handler: async (req, reply) => {
      const coords = validateTileCoords(req.params.z, req.params.x, req.params.y);
      if (!coords) {
        return reply.status(400).send({ message: "Invalid tile coordinates" });
      }
      const [z, x, y] = coords;

      const baseUrl = envString(
        "WAYMARKED_CYCLING_TILE_URL",
        "https://tile.waymarkedtrails.org/cycling/{z}/{x}/{y}.png",
      );

      const url = baseUrl
        .replace("{z}", String(z))
        .replace("{x}", String(x))
        .replace("{y}", String(y));

      try {
        const response = await fetch(url, {
          headers: {
            "User-Agent": USER_AGENT,
          },
          signal: AbortSignal.timeout(15_000),
        });

        if (!response.ok) {
          return reply.status(response.status).send({ message: "Upstream tile fetch failed" });
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        reply.header("Cache-Control", "public, max-age=604800, s-maxage=604800");
        reply.header("Cross-Origin-Resource-Policy", "cross-origin");
        reply.type("image/png");
        return reply.send(buffer);
      } catch (error) {
        req.log.warn({ err: error, z, x, y }, "Waymarked Trails tile fetch failed");
        return reply.status(502).send({ message: "Waymarked Trails tile provider unavailable" });
      }
    },
  });
};

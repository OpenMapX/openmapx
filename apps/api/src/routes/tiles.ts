import { USER_AGENT } from "@openmapx/core";
import {
  createBoundedBinaryProxyStream,
  MAX_RASTER_TILE_BYTES,
  readBoundedBinaryResponse,
} from "@openmapx/core/server";
import { envString } from "@openmapx/core/server-env";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import {
  encodeRasterContributors,
  RASTER_CONTRIBUTORS_HEADER,
} from "@openmapx/mobility-core/raster-contributors";
import type { FastifyPluginAsync } from "fastify";
import { bindRequestAbort, withDeadline } from "../utils/request-abort.js";
import { declareRouteAuth } from "../utils/route-auth.js";
import { parseWebMercatorTileCoordinates } from "../utils/tile-coordinates.js";
import {
  discardUpstreamResponse,
  normalizeUpstreamResponseStream,
} from "../utils/upstream-response.js";

const CYCLOSM_MAX_ZOOM = 20;
const WAYMARKED_MAX_ZOOM = 18;
const PNG_MEDIA_TYPES = ["image/png"] as const;

const OSM_ATTRIBUTION: Attribution = {
  sourceId: "openstreetmap",
  name: "© OpenStreetMap contributors",
  url: "https://www.openstreetmap.org/copyright",
  licensing: {
    version: 1,
    bindings: [
      {
        scope: "data",
        subject: "Data",
        license: {
          kind: "spdx",
          expression: "ODbL-1.0",
          url: "https://opendatacommons.org/licenses/odbl/",
        },
      },
    ],
  } as const,
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

export const tilesRoute: FastifyPluginAsync = async (fastify) => {
  declareRouteAuth(fastify, "public");

  // Cycling base layer tile proxy (Thunderforest primary, CyclOSM fallback)
  fastify.get<{
    Params: { z: string; x: string; y: string };
  }>("/tiles/cyclosm/:z/:x/:y.png", {
    schema: { params: TILE_PARAMS_SCHEMA },
    handler: async (req, reply) => {
      const coords = parseWebMercatorTileCoordinates(
        req.params.z,
        req.params.x,
        req.params.y,
        CYCLOSM_MAX_ZOOM,
      );
      if (!coords) {
        return reply.status(400).send({ message: "Invalid tile coordinates" });
      }
      const { z, x, y } = coords;
      reply.header("Cache-Control", "no-store");
      const requestAbort = bindRequestAbort(req, reply);

      try {
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
              redirect: "error",
              signal: withDeadline(requestAbort.signal, 10_000),
            });

            if (!tfResponse.ok) {
              discardUpstreamResponse(tfResponse);
              throw new Error(`Thunderforest returned ${tfResponse.status}`);
            }

            const { data } = await readBoundedBinaryResponse(tfResponse, {
              maxBytes: MAX_RASTER_TILE_BYTES,
              allowedContentTypes: PNG_MEDIA_TYPES,
              label: "Thunderforest tile",
            });
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
            return reply.send(data);
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
            signal: withDeadline(requestAbort.signal, 10_000),
          });

          if (!response.ok) {
            discardUpstreamResponse(response);
            return reply.status(response.status).send({ message: "Upstream tile fetch failed" });
          }

          const { data } = await readBoundedBinaryResponse(response, {
            maxBytes: MAX_RASTER_TILE_BYTES,
            allowedContentTypes: PNG_MEDIA_TYPES,
            label: "CyclOSM tile",
          });
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
          return reply.send(data);
        } catch (error) {
          req.log.warn({ err: error, z, x, y }, "CyclOSM fallback tile fetch failed");
          return reply.status(502).send({ message: "All cycling tile providers unavailable" });
        }
      } finally {
        requestAbort.dispose();
      }
    },
  });

  // Waymarked Trails cycling routes tile proxy
  fastify.get<{
    Params: { z: string; x: string; y: string };
  }>("/tiles/cycling-routes/:z/:x/:y.png", {
    schema: { params: TILE_PARAMS_SCHEMA },
    handler: async (req, reply) => {
      const coords = parseWebMercatorTileCoordinates(
        req.params.z,
        req.params.x,
        req.params.y,
        WAYMARKED_MAX_ZOOM,
      );
      if (!coords) {
        return reply.status(400).send({ message: "Invalid tile coordinates" });
      }
      const { z, x, y } = coords;
      reply.header("Cache-Control", "no-store");
      const requestAbort = bindRequestAbort(req, reply);

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
          signal: withDeadline(requestAbort.signal, 15_000),
        });

        if (!response.ok) {
          discardUpstreamResponse(response);
          return reply.status(response.status).send({ message: "Upstream tile fetch failed" });
        }

        const proxy = createBoundedBinaryProxyStream(response, {
          maxBytes: MAX_RASTER_TILE_BYTES,
          allowedContentTypes: PNG_MEDIA_TYPES,
          label: "Waymarked Trails tile",
        });
        reply.header("Cache-Control", "public, max-age=604800, s-maxage=604800");
        reply.header("Cross-Origin-Resource-Policy", "cross-origin");
        reply.type(proxy.contentType);
        return reply.send(
          normalizeUpstreamResponseStream(
            proxy.body,
            "Waymarked Trails tile provider returned an invalid response",
          ),
        );
      } catch (error) {
        req.log.warn({ err: error, z, x, y }, "Waymarked Trails tile fetch failed");
        return reply.status(502).send({ message: "Waymarked Trails tile provider unavailable" });
      }
    },
  });
};

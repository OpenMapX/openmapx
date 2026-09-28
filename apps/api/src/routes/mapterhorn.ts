import { USER_AGENT } from "@openmapx/core";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { declareRouteAuth } from "../utils/route-auth.js";

const TILE_ORIGIN = "https://tiles.mapterhorn.com";
const MAX_TILE_BYTES = 2 * 1024 * 1024;
const ATTRIBUTION = '<a href="https://mapterhorn.com/attribution/">© Mapterhorn</a>';

function publicBaseUrl(req: FastifyRequest): string {
  const configured = process.env.PUBLIC_BASE_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  const domain = process.env.DOMAIN?.trim();
  if (domain && domain !== "localhost") return `https://${domain}`;
  return `${req.protocol ?? "http"}://${req.headers.host ?? "localhost:3001"}`;
}

export const mapterhornRoute: FastifyPluginAsync = async (fastify) => {
  declareRouteAuth(fastify, "public");

  fastify.get("/mapterhorn/tiles.json", async (req, reply) => {
    reply.header("Cache-Control", "public, max-age=86400, s-maxage=86400");
    return reply.send({
      tilejson: "3.0.0",
      name: "Mapterhorn terrain",
      tiles: [`${publicBaseUrl(req)}/api/mapterhorn/{z}/{x}/{y}.webp`],
      minzoom: 0,
      maxzoom: 17,
      tileSize: 512,
      encoding: "terrarium",
      attribution: ATTRIBUTION,
    });
  });

  fastify.get<{ Params: { z: string; x: string; y: string } }>(
    "/mapterhorn/:z/:x/:y.webp",
    async (req, reply) => {
      const { z, x, y } = req.params;
      if (
        !/^(?:0|[1-9]\d*)$/.test(z) ||
        !/^(?:0|[1-9]\d*)$/.test(x) ||
        !/^(?:0|[1-9]\d*)$/.test(y)
      ) {
        return reply.status(400).send({ message: "Invalid terrain tile coordinate" });
      }
      const zoom = Number(z);
      if (zoom > 17 || Number(x) >= 2 ** zoom || Number(y) >= 2 ** zoom) {
        return reply.status(400).send({ message: "Invalid terrain tile coordinate" });
      }

      let upstream: Response;
      try {
        upstream = await fetch(`${TILE_ORIGIN}/${z}/${x}/${y}.webp`, {
          headers: { "User-Agent": USER_AGENT },
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        return reply.status(502).send({ message: "Terrain provider unavailable" });
      }
      if (!upstream.ok) {
        await upstream.body?.cancel();
        return reply
          .status(upstream.status === 404 ? 404 : 502)
          .send({ message: "Terrain tile unavailable" });
      }
      if (upstream.headers.get("content-type")?.split(";", 1)[0] !== "image/webp") {
        await upstream.body?.cancel();
        return reply.status(502).send({ message: "Unexpected terrain tile format" });
      }
      const declaredLength = Number(upstream.headers.get("content-length"));
      if (declaredLength > MAX_TILE_BYTES) {
        await upstream.body?.cancel();
        return reply.status(502).send({ message: "Terrain tile too large" });
      }
      if (!upstream.body) return reply.status(502).send({ message: "Empty terrain tile" });

      const reader = upstream.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_TILE_BYTES) {
            await reader.cancel();
            return reply.status(502).send({ message: "Terrain tile too large" });
          }
          chunks.push(value);
        }
      } catch {
        await reader.cancel().catch(() => {});
        return reply.status(502).send({ message: "Terrain provider unavailable" });
      }
      if (size === 0) return reply.status(502).send({ message: "Empty terrain tile" });
      reply.header("Cache-Control", "public, max-age=604800, s-maxage=604800");
      reply.header("Cross-Origin-Resource-Policy", "cross-origin");
      return reply.type("image/webp").send(Buffer.concat(chunks, size));
    },
  );
};

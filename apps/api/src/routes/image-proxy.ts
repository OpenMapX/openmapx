import type { FastifyPluginAsync } from "fastify";
import { resolveGooglePhotosLink } from "../services/photos/index.js";

/**
 * Allowed upstream hostname patterns for the image proxy.
 * Prevents abuse by only allowing known photo-source domains.
 */
const ALLOWED_HOSTS = [
  // Wikimedia Commons
  "upload.wikimedia.org",
  "commons.wikimedia.org",
  // Mapillary (CDN uses regional subdomains like scontent-fra5-2.xx.fbcdn.net)
  "images.mapillary.com",
  "fbcdn.net",
  // Flickr
  "live.staticflickr.com",
  // Panoramax
  "api.panoramax.xyz",
  "panoramax.openstreetmap.fr",
  // Google (resolved Google Photos)
  "lh3.googleusercontent.com",
  "lh4.googleusercontent.com",
  "lh5.googleusercontent.com",
  "lh6.googleusercontent.com",
  // Google Photos (share links resolved on the fly)
  "photos.app.goo.gl",
  "photos.google.com",
  // OpenStreetMap / other
  "tile.openstreetmap.org",
];

function isAllowedHost(hostname: string): boolean {
  return ALLOWED_HOSTS.some((h) => hostname === h || hostname.endsWith(`.${h}`));
}

/** Allowed frontend origins that may use the proxy. */
function getAllowedOrigins(): string[] {
  return (process.env.CORS_ORIGIN ?? "http://localhost:3000").split(",").map((o) => o.trim());
}

const MAX_SIZE = 15 * 1024 * 1024; // 15 MB

export const imageProxyRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Querystring: { url: string } }>("/image-proxy", {
    schema: {
      querystring: {
        type: "object",
        required: ["url"],
        properties: {
          url: { type: "string", minLength: 10 },
        },
      },
    },
    handler: async (req, reply) => {
      // Referrer guard: only allow requests originating from our frontend.
      // Browsers send Referer on <img> loads; third-party sites get blocked.
      const referer = req.headers.referer ?? req.headers.origin;
      if (referer) {
        const origins = getAllowedOrigins();
        const allowed = origins.some((o) => referer.startsWith(o));
        if (!allowed) {
          return reply.status(403).send({ message: "Forbidden" });
        }
      }

      const { url } = req.query;

      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return reply.status(400).send({ message: "Invalid URL" });
      }

      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        return reply.status(400).send({ message: "Only HTTP(S) URLs allowed" });
      }

      if (!isAllowedHost(parsed.hostname)) {
        return reply.status(403).send({ message: "Domain not allowed" });
      }

      // Google Photos share links are not direct images — resolve to actual image URL
      let imageUrl = url;
      if (parsed.hostname === "photos.app.goo.gl" || parsed.hostname === "photos.google.com") {
        const resolved = await resolveGooglePhotosLink(url);
        if (resolved.length === 0) {
          return reply.status(404).send({ message: "Could not resolve Google Photos link" });
        }
        imageUrl = resolved[0];
      }

      try {
        const upstream = await fetch(imageUrl, {
          signal: AbortSignal.timeout(10_000),
          headers: { "User-Agent": "OpenMapX/1.0" },
          redirect: "follow",
        });

        if (!upstream.ok) {
          return reply.status(upstream.status).send({ message: "Upstream error" });
        }

        const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
        if (!contentType.startsWith("image/")) {
          return reply.status(415).send({ message: "Not an image" });
        }

        const contentLength = upstream.headers.get("content-length");
        if (contentLength && parseInt(contentLength, 10) > MAX_SIZE) {
          return reply.status(413).send({ message: "Image too large" });
        }

        const bytes = await upstream.arrayBuffer();
        const origins = getAllowedOrigins();
        reply.header("Cache-Control", "public, max-age=86400, s-maxage=86400");
        reply.header("Cross-Origin-Resource-Policy", "cross-origin");
        reply.header("Access-Control-Allow-Origin", origins[0]);
        reply.type(contentType);
        return reply.send(Buffer.from(bytes));
      } catch (err) {
        req.log.warn({ url, err }, "Image proxy fetch failed");
        return reply.status(502).send({ message: "Failed to fetch image" });
      }
    },
  });
};

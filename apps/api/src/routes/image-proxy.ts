import { fetchWithRedirects, USER_AGENT } from "@openmapx/core";
import type { FastifyPluginAsync } from "fastify";
import { resolveGooglePhotosLink } from "../../../../integrations/photos/orchestrator.js";

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
  // Entur Mobility branding/vehicle assets exposed by the server-side provider.
  "api.entur.io",
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
      // Referrer guard: require a Referer or Origin that matches one of our
      // frontend origins. Browsers send Referer on <img> loads; third-party
      // sites are rejected. A missing Referer/Origin (non-browser clients,
      // stripped-referrer policies) is also rejected — the proxy exists for
      // the web UI, not as a generic open relay.
      const referer = req.headers.referer ?? req.headers.origin;
      const origins = getAllowedOrigins();
      if (!referer || !origins.some((o) => referer.startsWith(o))) {
        return reply.status(403).send({ message: "Forbidden" });
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
        // Manual redirect handling — each Location target is re-checked against
        // the allowlist, so an allowed host cannot redirect out to an arbitrary
        // third-party origin.
        const upstream = await fetchWithRedirects(imageUrl, {
          timeoutMs: 10_000,
          headers: { "User-Agent": USER_AGENT },
          maxRedirects: 5,
          validateRedirectUrl: (next) => isAllowedHost(next.hostname),
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

        if (!upstream.body) {
          return reply.status(502).send({ message: "Empty upstream body" });
        }

        // Stream the upstream body chunk-by-chunk to the client with a hard
        // byte counter, so a missing or misleading Content-Length cannot
        // force unbounded buffering on the proxy. Headers are flushed before
        // the first chunk; on overflow we destroy the socket because the
        // status line has already been sent.
        reply.header("Cache-Control", "public, max-age=86400, s-maxage=86400");
        reply.header("Cross-Origin-Resource-Policy", "cross-origin");
        reply.header("Access-Control-Allow-Origin", origins[0]);
        if (contentLength && parseInt(contentLength, 10) <= MAX_SIZE) {
          reply.header("Content-Length", contentLength);
        }
        reply.type(contentType);
        // Flush headers — `reply.raw.flushHeaders()` is a no-op if already sent.
        reply.raw.flushHeaders?.();

        const reader = upstream.body.getReader();
        let total = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > MAX_SIZE) {
              await reader.cancel().catch(() => {});
              reply.raw.destroy(new Error("Image too large"));
              return reply;
            }
            // Backpressure: pause reading when the socket buffer is full.
            const ok = reply.raw.write(Buffer.from(value));
            if (!ok) {
              await new Promise<void>((resolve) => reply.raw.once("drain", resolve));
            }
          }
          reply.raw.end();
        } finally {
          reader.releaseLock?.();
        }
        return reply;
      } catch (err) {
        req.log.warn({ url, err }, "Image proxy fetch failed");
        return reply.status(502).send({ message: "Failed to fetch image" });
      }
    },
  });
};

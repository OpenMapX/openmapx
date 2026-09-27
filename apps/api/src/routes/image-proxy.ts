import { isGooglePhotosImageUrl, resolveGooglePhotosLink } from "@integrations/photos/orchestrator";
import { fetchWithRedirects, USER_AGENT } from "@openmapx/core";
import { envString } from "@openmapx/core/server-env";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { requestNetworkKey } from "../utils/rate-limit.js";
import { declareRouteAuth } from "../utils/route-auth.js";
import { safeErrorClass, summarizeExternalUrl } from "../utils/safe-log-fields.js";
import { isAllowedHost } from "./image-hosts.js";
import { createImageProxyBudgetFromEnv } from "./image-proxy-budget.js";

export { isAllowedHost } from "./image-hosts.js";

/** Allowed frontend origins that may use the proxy. */
function getAllowedOrigins(): string[] {
  return envString("CORS_ORIGIN", "http://localhost:3000")
    .split(",")
    .map((o) => o.trim());
}

const MAX_SIZE = 15 * 1024 * 1024; // 15 MB

function parseContentLength(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

async function cancelResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {});
}

function waitForDrain(reply: FastifyReply, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      reply.raw.removeListener("drain", onDrain);
      signal.removeEventListener("abort", onAbort);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onAbort = () => {
      cleanup();
      reject(signal.reason instanceof Error ? signal.reason : new Error("Client disconnected"));
    };
    reply.raw.once("drain", onDrain);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function sendBudgetExceeded(reply: FastifyReply, retryAfterSeconds = 1): FastifyReply {
  reply.header("Cache-Control", "private, no-store");
  reply.header("Pragma", "no-cache");
  reply.header("Retry-After", String(retryAfterSeconds));
  return reply.status(429).send({ message: "Image proxy capacity exceeded" });
}

export const imageProxyRoute: FastifyPluginAsync = async (fastify) => {
  declareRouteAuth(fastify, "public");
  const budget = createImageProxyBudgetFromEnv();

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
      // Referrer guard: require a Referer or Origin whose *origin* matches one
      // of our frontend origins exactly. Browsers send Referer on <img>
      // loads; third-party sites are rejected. A missing Referer/Origin
      // (non-browser clients, stripped-referrer policies) is also rejected —
      // the proxy exists for the web UI, not as a generic open relay.
      //
      // SECURITY: must compare parsed URL origins. A naive
      // `referer.startsWith("https://openmapx.example")` accepts
      // `https://openmapx.example.attacker.com/...` because string prefixes
      // ignore the origin boundary, letting anyone controlling a subdomain
      // turn the proxy into an unmetered image-fetch relay for allowlisted
      // upstreams.
      const refererHeader = req.headers.referer ?? req.headers.origin;
      const origins = getAllowedOrigins();
      let refererOrigin: string | null = null;
      if (refererHeader) {
        try {
          refererOrigin = new URL(refererHeader).origin;
        } catch {
          // malformed Referer/Origin → treat as missing
        }
      }
      if (!refererOrigin || !origins.includes(refererOrigin)) {
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

      const lease = budget.tryAcquire(requestNetworkKey(req));
      if (!lease) return sendBudgetExceeded(reply);
      const clientAbort = new AbortController();
      const abortClientRequest = () => {
        if (!clientAbort.signal.aborted) {
          clientAbort.abort(new Error("Image proxy client disconnected"));
        }
      };
      const abortClosedResponse = () => {
        if (!reply.raw.writableEnded) abortClientRequest();
      };
      req.raw.once("aborted", abortClientRequest);
      reply.raw.once("close", abortClosedResponse);

      try {
        // Google Photos share links are not direct images — resolve to actual image URL
        let imageUrl = url;
        let resolvedGooglePhotos = false;
        if (parsed.hostname === "photos.app.goo.gl" || parsed.hostname === "photos.google.com") {
          const resolved = await resolveGooglePhotosLink(url);
          if (resolved.length === 0) {
            return reply.status(404).send({ message: "Could not resolve Google Photos link" });
          }
          imageUrl = resolved[0];
          resolvedGooglePhotos = true;
          // The resolver is a dependency, not an allowlist bypass. Validate its
          // initial output independently before the first socket is opened.
          if (!isGooglePhotosImageUrl(imageUrl)) {
            return reply.status(403).send({ message: "Domain not allowed" });
          }
        }

        try {
          // Manual redirect handling — each Location target is re-checked against
          // the allowlist, so an allowed host cannot redirect out to an arbitrary
          // third-party origin.
          const upstream = await fetchWithRedirects(imageUrl, {
            timeoutMs: 10_000,
            signal: clientAbort.signal,
            headers: { "User-Agent": USER_AGENT },
            maxRedirects: 5,
            validateRedirectUrl: (next) =>
              resolvedGooglePhotos
                ? isGooglePhotosImageUrl(next)
                : (next.protocol === "https:" || next.protocol === "http:") &&
                  isAllowedHost(next.hostname),
          });

          if (!upstream.ok) {
            await cancelResponseBody(upstream);
            return reply.status(upstream.status).send({ message: "Upstream error" });
          }

          const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
          if (!contentType.startsWith("image/")) {
            await cancelResponseBody(upstream);
            return reply.status(415).send({ message: "Not an image" });
          }

          const contentLength = upstream.headers.get("content-length");
          const declaredBytes = parseContentLength(contentLength);
          if (declaredBytes !== null && declaredBytes > MAX_SIZE) {
            await cancelResponseBody(upstream);
            return reply.status(413).send({ message: "Image too large" });
          }

          if (!upstream.body) {
            return reply.status(502).send({ message: "Empty upstream body" });
          }

          let chargedBytes = 0;
          if (declaredBytes !== null && Number.isFinite(declaredBytes) && declaredBytes >= 0) {
            const quota = lease.consume(declaredBytes);
            if (!quota.allowed) {
              await upstream.body.cancel().catch(() => {});
              return sendBudgetExceeded(reply, quota.retryAfterSeconds);
            }
            chargedBytes = declaredBytes;
          }

          // Stream the upstream body chunk-by-chunk to the client with a hard
          // byte counter, so a missing or misleading Content-Length cannot
          // force unbounded buffering on the proxy. Headers are flushed before
          // the first chunk; on overflow we destroy the socket because the
          // status line has already been sent.
          //
          // Set headers via `reply.raw.setHeader` rather than `reply.header`:
          // Fastify only flushes its internal header store when `reply.send`
          // runs, and we bypass that here by writing to `reply.raw` directly.
          // We also have to override the helmet defaults (Cross-Origin-
          // Resource-Policy: same-origin would block cross-origin <img> loads,
          // and the missing Content-Type combined with X-Content-Type-Options:
          // nosniff would refuse to render the bytes as an image).
          reply.hijack();
          reply.raw.setHeader("Cache-Control", "public, max-age=86400, s-maxage=86400");
          reply.raw.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
          reply.raw.setHeader("Access-Control-Allow-Origin", refererOrigin);
          // ACAO is set per request to the matched frontend origin, so a CDN must
          // key its cache by Origin to avoid serving an entry stamped for origin-A
          // to a CORS read from origin-B (which would then fail the browser check).
          reply.raw.setHeader("Vary", "Origin");
          reply.raw.setHeader("Content-Type", contentType);
          if (declaredBytes !== null && declaredBytes <= MAX_SIZE) {
            reply.raw.setHeader("Content-Length", contentLength as string);
          }
          reply.raw.flushHeaders?.();

          const reader = upstream.body.getReader();
          let total = 0;
          const cancelActiveBody = () => {
            void reader.cancel(clientAbort.signal.reason).catch(() => {});
          };
          clientAbort.signal.addEventListener("abort", cancelActiveBody, { once: true });
          if (clientAbort.signal.aborted) cancelActiveBody();
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
              const unchargedBytes = Math.max(0, total - chargedBytes);
              if (unchargedBytes > 0) {
                const quota = lease.consume(unchargedBytes);
                if (!quota.allowed) {
                  await reader.cancel().catch(() => {});
                  reply.raw.destroy(new Error("Image proxy byte budget exceeded"));
                  return reply;
                }
                chargedBytes = total;
              }
              // Backpressure: pause reading when the socket buffer is full.
              const ok = reply.raw.write(Buffer.from(value));
              if (!ok) {
                await waitForDrain(reply, clientAbort.signal);
              }
            }
            if (!reply.raw.destroyed) reply.raw.end();
          } finally {
            // Content-Length is only a reservation. Charge the bytes that were
            // actually read so an overstated upstream length cannot consume a
            // client's budget for data that was never transferred.
            lease.refund(Math.max(0, chargedBytes - total));
            clientAbort.signal.removeEventListener("abort", cancelActiveBody);
            reader.releaseLock?.();
          }
          return reply;
        } catch (err) {
          req.log.warn(
            { imageSource: summarizeExternalUrl(url), errorClass: safeErrorClass(err) },
            "Image proxy fetch failed",
          );
          // If the stream failed AFTER headers were flushed (line above), a 502
          // send would be a double-send (ERR_HTTP_HEADERS_SENT). Abort the socket
          // so the client sees a truncated response instead, matching the
          // too-large path above.
          if (reply.raw.headersSent) {
            reply.raw.destroy(err instanceof Error ? err : new Error("Image proxy stream failed"));
            return reply;
          }
          return reply.status(502).send({ message: "Failed to fetch image" });
        }
      } finally {
        req.raw.removeListener("aborted", abortClientRequest);
        reply.raw.removeListener("close", abortClosedResponse);
        lease.release();
      }
    },
  });
};

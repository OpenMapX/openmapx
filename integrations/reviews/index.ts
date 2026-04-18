import type { IntegrationContext } from "@openmapx/core";
import {
  cacheKeyForSubject,
  fetchAggregate,
  fetchReviews,
  initReviewsOrchestrator,
  submitReview,
  uploadReviewImage,
} from "./orchestrator.js";
import type { ReviewSubject } from "./types.js";

/** Cache TTL for read endpoints (10 minutes). */
const READ_TTL_SECONDS = 600;

/** MIME types accepted by the Mangrove image upload proxy. */
const ALLOWED_IMAGE_MIMES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

function parseSubject(query: Record<string, string>): ReviewSubject | null {
  const lat = Number.parseFloat(query.lat);
  const lng = Number.parseFloat(query.lng);
  const name = query.name?.trim();
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  if (!name) return null;
  return { lat, lng, name, osmId: query.osmId?.trim() || undefined };
}

export function setup(ctx: IntegrationContext): void {
  initReviewsOrchestrator(ctx);

  /** GET /reviews — list reviews for a subject (Redis-cached). */
  ctx.registerRoute("GET", "/reviews", async (req, reply) => {
    const subject = parseSubject(req.query);
    if (!subject) {
      reply.status(400).send({ error: "Invalid subject: lat, lng, name required" });
      return;
    }
    const key = `cache:reviews:list:${cacheKeyForSubject(subject)}`;
    try {
      const reviews = await ctx.cache.withCache(key, READ_TTL_SECONDS, () => fetchReviews(subject));
      // Redis handles server-side caching; tell the browser to always revalidate
      // so post-write invalidations (edits, deletes) are visible immediately.
      reply.header("Cache-Control", "no-store");
      reply.send({ reviews });
    } catch (err) {
      ctx.log.error("reviews:list failed", err);
      reply.status(502).send({ error: "Reviews unavailable" });
    }
  });

  /** GET /aggregate — stars + counts for a subject (Redis-cached). */
  ctx.registerRoute("GET", "/aggregate", async (req, reply) => {
    const subject = parseSubject(req.query);
    if (!subject) {
      reply.status(400).send({ error: "Invalid subject: lat, lng, name required" });
      return;
    }
    const key = `cache:reviews:agg:${cacheKeyForSubject(subject)}`;
    try {
      const aggregate = await ctx.cache.withCache(key, READ_TTL_SECONDS, () =>
        fetchAggregate(subject),
      );
      reply.header("Cache-Control", "no-store");
      reply.send({ aggregate });
    } catch (err) {
      ctx.log.error("reviews:aggregate failed", err);
      reply.status(502).send({ error: "Aggregate unavailable" });
    }
  });

  /**
   * POST /submit — accepts a pre-signed JWT and forwards it to the upstream provider.
   * Also accepts `invalidate: ReviewSubject` in the body so we can purge that subject's
   * cached reads on successful submission.
   *
   * Requires a logged-in session. The JWT itself is signed client-side with the
   * user's Mangrove keypair, but we still gate the relay so anonymous callers
   * can't use our server as an attribution-washing proxy into api.mangrove.reviews.
   */
  ctx.registerRoute(
    "POST",
    "/submit",
    async (req, reply) => {
      const body = req.body as { jwt?: unknown; invalidate?: Partial<ReviewSubject> } | null;
      const jwt = body?.jwt;
      if (typeof jwt !== "string" || jwt.split(".").length !== 3) {
        reply.status(400).send({ error: "Missing or malformed jwt in request body" });
        return;
      }
      try {
        const result = await submitReview(jwt);
        // Best-effort cache invalidation for this subject's reads.
        if (
          body?.invalidate?.lat !== undefined &&
          body.invalidate.lng !== undefined &&
          body.invalidate.name
        ) {
          const subject: ReviewSubject = {
            lat: Number(body.invalidate.lat),
            lng: Number(body.invalidate.lng),
            name: String(body.invalidate.name),
          };
          const segment = cacheKeyForSubject(subject);
          await Promise.allSettled([
            ctx.cache.del(`cache:reviews:list:${segment}`),
            ctx.cache.del(`cache:reviews:agg:${segment}`),
          ]);
        }
        reply.send(result);
      } catch (err) {
        ctx.log.error("reviews:submit failed", err);
        const message = err instanceof Error ? err.message : "Submission failed";
        reply.status(502).send({ error: message });
      }
    },
    { requireAuth: true },
  );

  /**
   * POST /image — accepts `{ dataUrl, filename? }` where dataUrl is a base64 data URL.
   * Decodes and streams to the upstream provider's image endpoint.
   * Response: { src } — the absolute URL to reference in a review's `images`.
   *
   * Requires auth so anonymous callers can't burn the Mangrove upload quota.
   */
  ctx.registerRoute(
    "POST",
    "/image",
    async (req, reply) => {
      const body = req.body as { dataUrl?: unknown; filename?: unknown } | null;
      if (typeof body?.dataUrl !== "string") {
        reply.status(400).send({ error: "Missing dataUrl in request body" });
        return;
      }
      const match = body.dataUrl.match(/^data:([^;,]+);base64,(.+)$/);
      if (!match) {
        reply.status(400).send({ error: "dataUrl must be a base64 data URL" });
        return;
      }
      const [, mimeType, base64] = match;
      const normalizedMime = mimeType.toLowerCase();
      if (!ALLOWED_IMAGE_MIMES.has(normalizedMime)) {
        reply.status(415).send({ error: "Unsupported image type" });
        return;
      }
      const buffer = Buffer.from(base64, "base64");
      if (buffer.byteLength === 0) {
        reply.status(400).send({ error: "Empty image payload" });
        return;
      }
      if (buffer.byteLength > 5 * 1024 * 1024) {
        reply.status(413).send({ error: "Image exceeds 5 MB" });
        return;
      }
      const ext = normalizedMime.split("/")[1];
      const filename =
        (typeof body.filename === "string" && body.filename.trim()) || `upload.${ext}`;
      const blob = new Blob([buffer], { type: normalizedMime });
      try {
        const result = await uploadReviewImage(blob, filename);
        reply.send(result);
      } catch (err) {
        ctx.log.error("reviews:image upload failed", err);
        const message = err instanceof Error ? err.message : "Upload failed";
        reply.status(502).send({ error: message });
      }
    },
    { requireAuth: true },
  );
}

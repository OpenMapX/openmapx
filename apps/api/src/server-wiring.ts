import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { envString } from "./utils/env";

// Trust proxy hops in front of the API. The default deployment terminates TLS
// at Traefik (one hop) and forwards to this container, so `request.ip` must be
// derived from the leftmost untrusted X-Forwarded-For entry rather than from
// the socket peer (which would always be the proxy). Without this, IP-keyed
// rate limits collapse to a single bucket per upstream proxy.
//
// SECURITY: never set this to `true` (trust everyone) on a public deployment
// — that would let any client spoof their IP via X-Forwarded-For and bypass
// rate limits, audit attribution, and the loopback admin short-circuit. Set
// `TRUST_PROXY_HOPS` to the *exact* number of proxies between the public
// internet and this process (default 1 = one Traefik hop). Set it to `0` for
// direct exposure (development).
export function trustProxyConfig(): number | boolean {
  const raw = process.env.TRUST_PROXY_HOPS?.trim();
  if (raw === undefined || raw === "") return 1; // default: assume one Traefik hop
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(
      `TRUST_PROXY_HOPS must be a non-negative integer (got "${raw}"). Use 0 for direct exposure, 1 for a single reverse proxy (default).`,
    );
  }
  return n;
}

// Uniform error body. Throwing handlers/guards (requireAuth/requireAdmin throw
// httpError, route validation throws with statusCode) would otherwise serialize
// via Fastify's default to `{ statusCode, error: "<HTTP phrase>", message }` —
// but every client reads `body.error` for the human-readable text, so a thrown
// 401 would show "Unauthorized" instead of "Authentication required". Restore
// the legacy `{ error: <message> }` shape for 4xx (matching the routes that
// still send it by hand), and never leak an internal 5xx message.
export function uniformErrorHandler(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const statusCode = error.statusCode ?? 500;
  if (statusCode >= 500) {
    request.log.error({ err: error }, "Request error");
    return reply.status(statusCode).send({ error: "Internal Server Error" });
  }
  return reply.status(statusCode).send({ error: error.message });
}

export function corsOptions() {
  return {
    origin: envString("CORS_ORIGIN", "http://localhost:3000")
      .split(",")
      .map((o) => o.trim()),
    credentials: true,
    exposedHeaders: ["X-Tile-Source"],
  };
}

// Tile-ish routes get their own tier because a single viewport change can
// fan out 30-60 requests; sharing a bucket with the rest of the API would
// let map panning starve unrelated traffic (autocomplete, place lookups).
export const TILE_PUBLIC_PATTERNS = [
  /^\/api\/maptiler\//,
  /^\/api\/tiles\//,
  /^\/api\/traffic\//,
  /^\/api\/integrations\/street-level-imagery-[a-z0-9-]+\/tiles\//,
];

export const EXPENSIVE_PUBLIC_PATTERNS = [
  /^\/api\/isochrone(\/|$|\?)/,
  /^\/api\/elevation(\/|$|\?)/,
  /^\/api\/motis(\/|$)/,
  /^\/api\/places(\/|$|\?)/,
  /^\/api\/image-proxy(\/|$|\?)/,
  /^\/api\/winter-sports(\/|$)/,
  /^\/api\/integrations\/search-nlp(\/|$|\?)/,
];

export const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

type Limit = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

export interface RateLimitTiers {
  auth: Limit;
  tile: Limit;
  expensive: Limit;
  public: Limit;
}

// Global rate limiting for the public surface.
//
// Skips:
//   - `/health` — used by Docker/Traefik healthchecks at high frequency.
//   - Loopback socket peers — the CLI and admin sweeps run locally; admin
//     endpoints layer their own per-action limiters on top (see `admin.ts`,
//     `admin-store.ts`, `admin-services.ts`, `admin-settings.ts`). We read
//     `socket.remoteAddress` here, not `request.ip`, so a public client
//     cannot forge XFF to bypass the limit (see `require-admin.ts`).
//
// Tiers, applied in order:
//   - `/api/auth/*`              → strict (credential stuffing, email spam)
//   - tile / map asset routes    → generous (bursty, cacheable, CDN-friendly)
//   - expensive public routes    → tight (Valhalla, MOTIS, geocoding fan-out)
//   - everything else            → broad floor
export function makeRateLimitTierHook(limits: RateLimitTiers) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const url = request.url;
    if (url === "/health" || url.startsWith("/health?")) return;

    // Trust only the actual TCP peer here, never XFF.
    const peer = request.socket?.remoteAddress;
    if (peer && LOOPBACK.has(peer)) return;

    if (url.startsWith("/api/auth/")) {
      await limits.auth(request, reply);
      return;
    }
    if (TILE_PUBLIC_PATTERNS.some((p) => p.test(url))) {
      await limits.tile(request, reply);
      return;
    }
    if (EXPENSIVE_PUBLIC_PATTERNS.some((p) => p.test(url))) {
      await limits.expensive(request, reply);
      return;
    }
    if (url.startsWith("/api/")) {
      await limits.public(request, reply);
    }
  };
}

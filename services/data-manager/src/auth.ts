import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/**
 * Paths that bypass the bearer-token pre-handler:
 *   - `/live` and `/status` — liveness and readiness probes.
 *   - `/internal/metrics` — Prometheus scrape endpoint. The data-manager
 *     port is bound to 127.0.0.1 on the host (see service.json) so the
 *     surface is already firewalled off; matches the apps/api posture for
 *     its own `/internal/metrics` route.
 *   - one exact GET relay-capability path — the 256-bit, run-bound handle is
 *     the only authority upstream Python receives; malformed paths/methods
 *     still require the ordinary bearer token.
 */
const HEALTH_PATHS = new Set<string>(["/live", "/status", "/internal/metrics"]);
const OPERATOR_FEED_RELAY_PATH = /^\/internal\/transit\/operator-feed\/[a-f0-9]{64}$/i;

function bypassesBearerAuth(req: FastifyRequest): boolean {
  const path = req.url.split("?")[0] ?? "";
  if (HEALTH_PATHS.has(path)) return true;
  return req.method === "GET" && OPERATOR_FEED_RELAY_PATH.test(path);
}

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

function getAuthToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) {
    return header.slice("Bearer ".length).trim();
  }
  const custom = req.headers["x-data-manager-token"];
  if (typeof custom === "string") return custom.trim();
  return null;
}

/**
 * Resolves the expected shared-secret for the data-manager. Falls back to
 * generating an ephemeral secret when none is configured, and logs a warning.
 *
 * - `DATA_MANAGER_AUTH_TOKEN=<secret>` — required in production; all mutation
 *   endpoints demand a matching token.
 * - `DATA_MANAGER_AUTH_TOKEN=` (empty) or unset in development — a random
 *   token is generated at startup and printed to the log so the sibling
 *   `apps/api` process can pick it up via the same env var when running
 *   outside docker-compose.
 */
export function resolveAuthToken(app: FastifyInstance): string {
  const configured = process.env.DATA_MANAGER_AUTH_TOKEN?.trim();
  if (configured) return configured;

  if (process.env.NODE_ENV === "production") {
    app.log.error(
      "DATA_MANAGER_AUTH_TOKEN is required in production. Refusing to start with an ephemeral token.",
    );
    throw new Error("DATA_MANAGER_AUTH_TOKEN is required in production");
  }

  const ephemeral = randomBytes(32).toString("hex");
  app.log.warn(
    { token: ephemeral },
    "DATA_MANAGER_AUTH_TOKEN not set — generated ephemeral token for this run (dev only).",
  );
  return ephemeral;
}

/**
 * Registers a pre-handler that rejects every non-health request without a
 * matching bearer token. Health endpoints remain open so container/k8s probes
 * and cross-service discovery keep working.
 */
export function registerAuth(app: FastifyInstance, expectedToken: string): void {
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    if (bypassesBearerAuth(req)) return;
    const presented = getAuthToken(req);
    if (!presented || !safeEqual(presented, expectedToken)) {
      reply.code(401).send({ error: "Unauthorized" });
    }
  });
}

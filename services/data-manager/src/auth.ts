import { randomBytes, timingSafeEqual } from "node:crypto";
import rateLimit, { normalizeIP } from "@fastify/rate-limit";
import { controlHeaders } from "@openmapx/core/build-artifacts";
import { assertProductionApplicationSecret } from "@openmapx/core/deployment-secret-policy";
import { readServiceSecretFile } from "@openmapx/core/service-secret-files";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { DATA_MANAGER_PRINCIPALS, type DataManagerPrincipal } from "./principals.js";

export type DataManagerCallerTokens = Readonly<Record<DataManagerPrincipal, string>>;

/** The environment variable naming each caller's token file. */
const TOKEN_FILE_VARIABLES: Readonly<Record<DataManagerPrincipal, string>> = {
  api: "DATA_MANAGER_API_TOKEN_FILE",
  "ops-agent": "DATA_MANAGER_OPS_AGENT_TOKEN_FILE",
  "host-cli": "DATA_MANAGER_HOST_CLI_TOKEN_FILE",
};

/**
 * Paths that bypass the bearer-token pre-handler:
 *   - `/live` and `/status` — liveness and readiness probes.
 *   - one exact GET relay-capability path — the 256-bit, run-bound handle is
 *     the only authority upstream Python receives; malformed paths/methods
 *     still require the ordinary bearer token.
 */
const HEALTH_PATHS = new Set<string>(["/live", "/status"]);
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

/** Compares against every caller's token, so the time taken names none of them. */
function principalFor(
  presented: string | null,
  tokens: DataManagerCallerTokens,
): DataManagerPrincipal | null {
  if (!presented) return null;
  let found: DataManagerPrincipal | null = null;
  for (const principal of DATA_MANAGER_PRINCIPALS)
    if (safeEqual(presented, tokens[principal])) found = principal;
  return found;
}

const principals = new WeakMap<FastifyRequest, DataManagerPrincipal>();

/** The caller an authenticated request came from. */
export function requestPrincipal(req: FastifyRequest): DataManagerPrincipal | undefined {
  return principals.get(req);
}

/**
 * Reads each caller's token from the file its variable names. `openmapx
 * compose render` writes the three files and the deployment mounts them.
 *
 * Production refuses a missing, weak or shared token. In development a caller
 * without a configured file gets a random token for this run, which no other
 * process knows, so that caller's requests are refused.
 */
export function resolveCallerTokens(
  app: FastifyInstance,
  env: NodeJS.ProcessEnv = process.env,
): DataManagerCallerTokens {
  const production = env.NODE_ENV === "production";
  const tokens = {} as Record<DataManagerPrincipal, string>;
  for (const principal of DATA_MANAGER_PRINCIPALS) {
    const variable = TOKEN_FILE_VARIABLES[principal];
    const path = env[variable]?.trim();
    if (path) {
      const token = readServiceSecretFile(path, `Data-manager ${principal} token`);
      assertProductionApplicationSecret(variable, token, env.NODE_ENV);
      tokens[principal] = token;
      continue;
    }
    if (production) {
      app.log.error(`${variable} is required in production`);
      throw new Error(`${variable} is required in production`);
    }
    app.log.warn(
      `${variable} is not set; ${principal} requests are refused for this run (development only).`,
    );
    tokens[principal] = randomBytes(32).toString("hex");
  }
  assertDistinct(tokens);
  return tokens;
}

function assertDistinct(tokens: DataManagerCallerTokens): void {
  if (new Set(DATA_MANAGER_PRINCIPALS.map((principal) => tokens[principal])).size !== 3)
    throw new Error("Each data-manager caller needs its own token");
}

/** The callers a route admits, from its contract; a route without that list admits none. */
function routePrincipals(req: FastifyRequest): readonly string[] {
  const schema = req.routeOptions.schema as { "x-openmapx-principals"?: unknown } | undefined;
  const allowed = schema?.["x-openmapx-principals"];
  return Array.isArray(allowed) ? allowed : [];
}

/**
 * Registers an on-request authentication guard with a failed-attempt budget,
 * before body parsing. Health endpoints remain open so container/k8s probes
 * and cross-service discovery keep working. Each caller presents its own
 * token and reaches only the routes its contract lists for it.
 */
export function registerAuth(
  app: FastifyInstance,
  tokens: DataManagerCallerTokens,
  options: {
    executionReceiver?: () => import("./jobs/execution/api.js").DataExecutionReceiver | undefined;
  } = {},
): void {
  assertDistinct(tokens);
  // Register the maintained limiter in this root scope, while invoking it only
  // for failed credentials. Successful long-running jobs and probes have no
  // authentication-attempt budget. The root hook runs before body parsing.
  app.register(rateLimit, {
    global: false,
    max: 20,
    timeWindow: 60_000,
    keyGenerator: (req) =>
      `${normalizeIP(req.ip)}|${normalizeIP(req.socket.remoteAddress ?? req.ip)}`,
  });
  let limitFailedAuthentication: ReturnType<FastifyInstance["createRateLimit"]> | undefined;
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    if (bypassesBearerAuth(req)) return;
    const principal = principalFor(getAuthToken(req), tokens);
    if (!principal) {
      limitFailedAuthentication ??= app.createRateLimit();
      const limit = await limitFailedAuthentication(req);
      if (!limit.isAllowed && limit.isExceeded)
        return reply
          .code(429)
          .header("Retry-After", String(limit.ttlInSeconds))
          .send({ error: "Too many authentication attempts" });
      return reply.code(401).send({ error: "Unauthorized" });
    }
    // An unknown path falls through to the not-found reply.
    if (req.routeOptions.url !== undefined && !routePrincipals(req).includes(principal))
      return reply.code(403).send({ error: "This caller may not use this route" });
    principals.set(req, principal);
    // Durable receiver admission only. Never silently ignore an internal authority header.
    try {
      const headers = controlHeaders(req.raw.rawHeaders);
      const path = req.url.split("?")[0] ?? "";
      const admission =
        req.method === "POST" &&
        ([
          "/executions",
          "/executions/generation-hardlinks",
          "/executions/generation-hardlinks/recovery",
          "/executions/configuration-maintenance/prepare",
          "/executions/configuration-maintenance/recovery",
        ].includes(path) ||
          /^\/executions\/configuration-maintenance\/[a-f0-9-]{36}\/settle$/.test(path));
      if (
        (headers.delegation !== undefined || headers.parent !== undefined) &&
        (!admission || !options.executionReceiver?.())
      )
        return reply
          .code(503)
          .send({ error: "Managed data-manager execution requires the durable receiver upgrade" });
    } catch {
      return reply.code(403).send({ error: "Invalid control authority" });
    }
  });
}

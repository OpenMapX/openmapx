import type {
  LoadedIntegration,
  RouteHandler,
  RouteOptions,
} from "@openmapx/integration-framework";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RateLimitTiers } from "./server-wiring";
import { requireAuth } from "./utils/require-auth";

export type RegisteredIntegrationRoute = {
  integrationId: string;
  method: string;
  path: string;
  handler: RouteHandler;
  options?: RouteOptions;
  score: number;
};

let integrationRoutes: RegisteredIntegrationRoute[] = [];
let stagedIntegrationRoutes: RegisteredIntegrationRoute[] | null = null;
export const ROUTE_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD"] as const;
// biome-ignore lint/suspicious/noExplicitAny: accept any Fastify logger variant
let _routeDispatcherFastify: FastifyInstance<any, any, any, any> | null = null;
let routeRateLimits: Pick<RateLimitTiers, "public" | "expensive" | "tile"> | null = null;

export function setIntegrationRouteRateLimits(
  limits: Pick<RateLimitTiers, "public" | "expensive" | "tile"> | null,
): void {
  routeRateLimits = limits;
}

function normalizeRoutePath(path: string): string {
  const withSlash = path.startsWith("/") ? path : `/${path}`;
  return withSlash.length > 1 && withSlash.endsWith("/") ? withSlash.slice(0, -1) : withSlash;
}

function routeScore(path: string): number {
  if (path === "/") return 0;
  return path
    .slice(1)
    .split("/")
    .reduce((score, segment) => {
      if (segment === "*") return score;
      if (!segment.includes(":")) return score + 10;
      return score + (segment.replace(/:[A-Za-z_$][\w$]*/g, "").length > 0 ? 6 : 4);
    }, path.length);
}

export function registerIntegrationRoute(
  integrationId: string,
  method: string,
  path: string,
  handler: RouteHandler,
  options?: RouteOptions,
): void {
  const target = stagedIntegrationRoutes ?? integrationRoutes;
  target.push({
    integrationId,
    method: method.toUpperCase(),
    path: normalizeRoutePath(path),
    handler,
    options,
    score: routeScore(path),
  });
  target.sort((a, b) => b.score - a.score);
}

export function resetIntegrationRoutes(): void {
  integrationRoutes = [];
  stagedIntegrationRoutes = null;
}

/** Begin collecting a detached route table for an integration reload. */
export function beginIntegrationRouteStaging(): void {
  if (stagedIntegrationRoutes) throw new Error("integration route staging is already active");
  stagedIntegrationRoutes = [];
}

/** Atomically make the fully built staged route table visible to dispatchers. */
export function commitIntegrationRouteStaging(): void {
  if (!stagedIntegrationRoutes) throw new Error("integration route staging is not active");
  integrationRoutes = stagedIntegrationRoutes;
  stagedIntegrationRoutes = null;
}

/** Discard a failed staged route table, leaving active dispatch unchanged. */
export function rollbackIntegrationRouteStaging(): void {
  stagedIntegrationRoutes = null;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Matches against the raw, still percent-encoded path, so an encoded `/` inside
 * a param stays inside its segment. Captures come back encoded; the dispatcher
 * decodes each exactly once.
 */
function matchRoutePath(pattern: string, path: string): Record<string, string> | null {
  const patternSegments = pattern === "/" ? [] : pattern.slice(1).split("/");
  const pathSegments = path === "/" ? [] : path.slice(1).split("/");
  const params: Record<string, string> = {};

  for (let i = 0; i < patternSegments.length; i++) {
    const patternSegment = patternSegments[i];
    if (patternSegment === "*") {
      params["*"] = pathSegments.slice(i).join("/");
      return params;
    }

    const pathSegment = pathSegments[i];
    if (pathSegment === undefined) return null;

    const names: string[] = [];
    const regexSource = escapeRegex(patternSegment ?? "").replace(
      /:([A-Za-z_$][\w$]*)/g,
      (_full, name: string) => {
        names.push(name);
        return "([^/]+)";
      },
    );
    const match = pathSegment.match(new RegExp(`^${regexSource}$`));
    if (!match) return null;
    for (let j = 0; j < names.length; j++) {
      const captured = match[j + 1];
      if (captured !== undefined) params[names[j] as string] = captured;
    }
  }

  return patternSegments.length === pathSegments.length ? params : null;
}

function findIntegrationRoute(
  integrationId: string,
  method: string,
  path: string,
): { route: RegisteredIntegrationRoute; params: Record<string, string> } | null {
  const normalizedMethod = method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase();
  const normalizedPath = normalizeRoutePath(path);
  for (const route of integrationRoutes) {
    if (route.integrationId !== integrationId || route.method !== normalizedMethod) continue;
    const params = matchRoutePath(route.path, normalizedPath);
    if (params) return { route, params };
  }
  return null;
}

/**
 * The part of the request path the integration's own routes match, taken from
 * the raw request URL rather than Fastify's `*` param. Fastify has already
 * decoded that param, which turns an encoded `%2F` inside an id into a real `/`
 * and splits it across segments. Everything up to the dispatcher's `*` is one
 * raw segment per route segment (`:id` never spans a `/`), so dropping that many
 * raw segments leaves the integration path exactly as the client encoded it.
 */
function rawIntegrationPath(request: FastifyRequest): string {
  const wildcardAt = (request.routeOptions.url ?? "").split("/").indexOf("*");
  if (wildcardAt === -1) return "/";
  const rawUrl = request.raw.url ?? request.url;
  const pathEnd = rawUrl.search(/[?#]/);
  const rawPath = pathEnd === -1 ? rawUrl : rawUrl.slice(0, pathEnd);
  return `/${rawPath.split("/").slice(wildcardAt).join("/")}`;
}

/**
 * Decodes every captured param once. This cannot throw: the router rejects a
 * path holding a malformed escape with its own 400 before any handler runs,
 * and a capture is a `/`-bounded slice of that same path, so it never splits an
 * escape or a multi-byte sequence.
 */
function decodeParams(params: Record<string, string>): Record<string, string> {
  const decoded: Record<string, string> = {};
  for (const [name, value] of Object.entries(params)) decoded[name] = decodeURIComponent(value);
  return decoded;
}

/**
 * Router options that make the path the router matched differ from the raw
 * request path. `rawIntegrationPath` relies on the two agreeing segment for
 * segment, and no lossless way exists to rebuild one from the other: the
 * router's only output for the remainder is the fully decoded `*` param, which
 * has already lost the difference between `/` and `%2F`. Duplicate slashes
 * collapsed in the prefix shift every segment, a `;` delimiter moves part of
 * the path into the query string, and a trimmed trailing slash changes the
 * remainder. So the dispatcher refuses to run under any of them rather than
 * hand integrations a silently wrong path. `rewriteUrl` needs no guard: Fastify
 * writes the rewritten URL back to the raw request before routing, so the
 * router and `request.raw.url` see the same string. `caseSensitive: false` is
 * not guarded: the raw path is split by segment count, so a differently cased
 * prefix and the id's own case both pass through untouched (see the route
 * params test).
 */
const PATH_NORMALISING_ROUTER_OPTIONS = [
  "ignoreDuplicateSlashes",
  "useSemicolonDelimiter",
  "ignoreTrailingSlash",
] as const;

// biome-ignore lint/suspicious/noExplicitAny: accept any Fastify logger variant
function assertRawPathMatchesRouter(fastify: FastifyInstance<any, any, any, any>): void {
  const config = fastify.initialConfig as Record<string, unknown> & {
    routerOptions?: Record<string, unknown>;
  };
  for (const option of PATH_NORMALISING_ROUTER_OPTIONS) {
    if (config[option] === true || config.routerOptions?.[option] === true) {
      throw new Error(
        `The integration route dispatcher matches the raw request path, so it cannot run with the router option "${option}" enabled: the router would match a normalised path that the raw path no longer lines up with. Turn "${option}" off.`,
      );
    }
  }
}

export function registerIntegrationRouteDispatcher(
  // biome-ignore lint/suspicious/noExplicitAny: accept any Fastify logger variant
  fastify: FastifyInstance<any, any, any, any>,
  integrations: ReadonlyMap<string, LoadedIntegration>,
): void {
  if (_routeDispatcherFastify === fastify) return;
  assertRawPathMatchesRouter(fastify);
  _routeDispatcherFastify = fastify;

  const dispatch = async (request: FastifyRequest, reply: FastifyReply) => {
    const id = (request.params as { id?: string }).id;
    if (!id) return reply.status(404).send({ error: "Not found" });
    const integration = integrations.get(id);
    if (!integration?.enabled) return reply.status(404).send({ error: "Not found" });

    const routePath = rawIntegrationPath(request);
    const matched = findIntegrationRoute(id, request.method, routePath);
    if (!matched) return reply.status(404).send({ error: "Not found" });
    const routeParams = decodeParams(matched.params);

    const rateLimitTier = matched.route.options?.rateLimitTier ?? "public";
    const limiter = routeRateLimits?.[rateLimitTier];
    if (limiter) {
      await limiter(request, reply);
      if (reply.sent) return reply;
    }

    let userId: string | undefined;
    if (matched.route.options?.requireAuth === true) {
      userId = await requireAuth(request);
    }

    let didSend = false;
    const requestController = new AbortController();
    const abortRequest = () => requestController.abort();
    const abortDisconnectedReply = () => {
      if (!reply.raw.writableEnded) abortRequest();
    };
    request.raw.once("aborted", abortRequest);
    reply.raw.once("close", abortDisconnectedReply);
    try {
      await matched.route.handler(
        {
          query: request.query as Record<string, string | string[] | undefined>,
          params: routeParams,
          body: request.body,
          userId,
          headers: request.headers,
          signal: requestController.signal,
        },
        {
          send: (data) => {
            didSend = true;
            reply.send(data);
          },
          status: (code) => ({
            send: (data) => {
              didSend = true;
              reply.status(code).send(data);
            },
          }),
          header: (name, value) => {
            reply.header(name, value);
          },
          type: (contentType) => {
            reply.type(contentType);
          },
        },
      );
    } finally {
      request.raw.off("aborted", abortRequest);
      reply.raw.off("close", abortDisconnectedReply);
    }

    // A handler that returns without sending would leave the reply unsent;
    // `return reply` then hands Fastify an unfulfilled reply and the request
    // hangs until the socket times out. Fail it loudly instead so a broken
    // handler surfaces as a 500, not a stuck connection.
    if (!didSend) {
      request.log.error(
        { integrationId: id, path: routePath },
        "integration handler returned without sending a response",
      );
      return reply.status(500).send({ error: "Integration handler produced no response" });
    }

    // The integration handler sent its response through the shim above and
    // resolves to undefined; returning the reply hands control back to Fastify
    // as "already handled". Without it, the resolved-undefined handler races a
    // second send against the async preSerialization hook → ERR_HTTP_HEADERS_SENT
    // (see [[project-fastify-return-reply-contract]]).
    return reply;
  };

  fastify.route({ method: [...ROUTE_METHODS], url: "/api/integrations/:id", handler: dispatch });
  fastify.route({
    method: [...ROUTE_METHODS],
    url: "/api/integrations/:id/*",
    handler: dispatch,
  });
}

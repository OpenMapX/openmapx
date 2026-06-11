import type {
  LoadedIntegration,
  RouteHandler,
  RouteOptions,
} from "@openmapx/integration-framework";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireAuth } from "./utils/require-auth";

export type RegisteredIntegrationRoute = {
  integrationId: string;
  method: string;
  path: string;
  handler: RouteHandler;
  options?: RouteOptions;
  score: number;
};

const integrationRoutes: RegisteredIntegrationRoute[] = [];
export const ROUTE_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD"] as const;
// biome-ignore lint/suspicious/noExplicitAny: accept any Fastify logger variant
let _routeDispatcherFastify: FastifyInstance<any, any, any, any> | null = null;

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
  integrationRoutes.push({
    integrationId,
    method: method.toUpperCase(),
    path: normalizeRoutePath(path),
    handler,
    options,
    score: routeScore(path),
  });
  integrationRoutes.sort((a, b) => b.score - a.score);
}

export function resetIntegrationRoutes(): void {
  integrationRoutes.length = 0;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function matchRoutePath(pattern: string, path: string): Record<string, string> | null {
  const patternSegments = pattern === "/" ? [] : pattern.slice(1).split("/");
  const pathSegments = path === "/" ? [] : path.slice(1).split("/");
  const params: Record<string, string> = {};

  for (let i = 0; i < patternSegments.length; i++) {
    const patternSegment = patternSegments[i];
    if (patternSegment === "*") {
      params["*"] = decodeParam(pathSegments.slice(i).join("/"));
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
      if (captured !== undefined) params[names[j] as string] = decodeParam(captured);
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

export function registerIntegrationRouteDispatcher(
  // biome-ignore lint/suspicious/noExplicitAny: accept any Fastify logger variant
  fastify: FastifyInstance<any, any, any, any>,
  integrations: ReadonlyMap<string, LoadedIntegration>,
): void {
  if (_routeDispatcherFastify === fastify) return;
  _routeDispatcherFastify = fastify;

  const dispatch = async (request: FastifyRequest, reply: FastifyReply) => {
    const params = request.params as { id?: string; "*"?: string };
    const id = params.id;
    if (!id) return reply.status(404).send({ error: "Not found" });
    const integration = integrations.get(id);
    if (!integration?.enabled) return reply.status(404).send({ error: "Not found" });

    const routePath = params["*"] ? `/${params["*"]}` : "/";
    const matched = findIntegrationRoute(id, request.method, routePath);
    if (!matched) return reply.status(404).send({ error: "Not found" });

    let userId: string | undefined;
    if (matched.route.options?.requireAuth === true) {
      userId = await requireAuth(request);
    }

    let didSend = false;
    await matched.route.handler(
      {
        query: request.query as Record<string, string>,
        params: matched.params,
        body: request.body,
        userId,
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

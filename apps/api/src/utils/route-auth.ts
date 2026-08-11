import type { FastifyInstance } from "fastify";

/**
 * How a route authenticates its caller.
 *
 * `unspecified` is the absence of a classification, deliberately distinct from
 * `public`: a route nobody has classified must never be documented as open.
 */
export type AuthLevel =
  /** No credentials required. */
  | "public"
  /** A signed-in user session. */
  | "session"
  /** An administrator session. */
  | "admin"
  /** An administrator session or a service-to-service token. */
  | "service"
  /** No application-level check — reachability is expected to be restricted by the network. */
  | "internal"
  | "unspecified";

export const AUTH_LEVELS: readonly AuthLevel[] = [
  "public",
  "session",
  "admin",
  "service",
  "internal",
  "unspecified",
];

const declared = new Map<string, AuthLevel>();

function key(method: string, url: string): string {
  return `${method.toUpperCase()} ${url}`;
}

/**
 * Declares the auth level shared by every route in a plugin, so the generated
 * OpenAPI document can report it. Guards run inside handlers or in a plugin
 * `preHandler` hook and are not introspectable, so they have to be stated.
 *
 * Call it next to the guard it describes. A route may override the plugin-wide
 * level with its own `config: { auth: "..." }`.
 *
 * Recording happens in a plugin-scoped `onRoute` hook rather than by mutating
 * the route's `config`: an outer hook has already observed the route by then,
 * so the mutation would not reach the collector.
 */
export function declareRouteAuth(
  // biome-ignore lint/suspicious/noExplicitAny: accept any Fastify logger variant
  fastify: FastifyInstance<any, any, any, any>,
  auth: AuthLevel,
): void {
  fastify.addHook("onRoute", (routeOptions) => {
    const override = (routeOptions.config as { auth?: AuthLevel } | undefined)?.auth;
    const methods = Array.isArray(routeOptions.method)
      ? routeOptions.method
      : [routeOptions.method];
    for (const method of methods) declared.set(key(method, routeOptions.url), override ?? auth);
  });
}

/** The level declared for a route, if any. Used by the OpenAPI generator. */
export function declaredRouteAuth(method: string, url: string): AuthLevel | undefined {
  return declared.get(key(method, url));
}

/** Clears the registry so a second in-process mount starts clean. */
export function resetDeclaredRouteAuth(): void {
  declared.clear();
}

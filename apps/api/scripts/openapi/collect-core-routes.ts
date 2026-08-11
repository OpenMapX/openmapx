import fastifySwagger from "@fastify/swagger";
import Fastify from "fastify";
import type { AuthLevel, CoreRouteEntry } from "./build-document.js";
import { AUTH_LEVELS } from "./build-document.js";

export interface CoreRouteCollection {
  paths: Record<string, Record<string, unknown>>;
  auth: CoreRouteEntry[];
}

function readAuthLevel(config: unknown): AuthLevel {
  const declared = (config as { auth?: unknown } | undefined)?.auth;
  if (typeof declared !== "string") return "unspecified";
  if (!(AUTH_LEVELS as readonly string[]).includes(declared)) {
    throw new Error(
      `Route declared config.auth "${declared}", which is not one of ${AUTH_LEVELS.join(", ")}.`,
    );
  }
  return declared as AuthLevel;
}

/**
 * Reads the core HTTP surface out of Fastify's own route table.
 *
 * Mounts `registerCoreRoutes` on a bare instance and never calls `listen`, so
 * no port is bound. The route modules import the database and cache clients,
 * but both are lazy and nothing connects until a request arrives.
 *
 * Auth comes from each route's `config.auth` marker rather than from the schema:
 * the guards run inside handlers and are not introspectable, and keeping the
 * marker in `config` keeps OpenAPI vocabulary out of the route files.
 */
export async function collectCoreRoutes(): Promise<CoreRouteCollection> {
  // Better Auth asserts on this at import time. The value is never used: no
  // token is issued or verified during generation.
  process.env.BETTER_AUTH_SECRET ||=
    "openapi-generation-stub-secret-not-used-for-any-real-token-issuance";

  const { registerCoreRoutes } = await import("../../src/routes/index.js");

  const app = Fastify({ logger: false, routerOptions: { maxParamLength: 500 } });
  const auth: CoreRouteEntry[] = [];

  app.addHook("onRoute", (routeOptions) => {
    const methods = Array.isArray(routeOptions.method)
      ? routeOptions.method
      : [routeOptions.method];
    for (const method of methods) {
      // Fastify derives HEAD from GET; documenting both adds noise, not surface.
      if (method === "HEAD") continue;
      auth.push({ method, url: routeOptions.url, auth: readAuthLevel(routeOptions.config) });
    }
  });

  await app.register(fastifySwagger, {
    openapi: {
      openapi: "3.1.0",
      info: { title: "OpenMapX API", version: "1.0.0" },
    },
  });

  await registerCoreRoutes(app, {
    authHandler: async () => new Response(null, { status: 204 }),
    authUiOrigin: "http://localhost:3000",
  });

  await app.ready();
  const document = app.swagger() as { paths?: Record<string, Record<string, unknown>> };
  const paths = document.paths ?? {};
  await app.close();

  return { paths, auth };
}

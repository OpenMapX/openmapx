import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXPENSIVE_ROUTE_PREFIXES, TILE_ROUTE_PREFIXES } from "../../server-wiring.js";

// `registerCoreRoutes` pulls in Better Auth, which asserts on this at import
// time. The generator sets the same stub for the same reason.
process.env.BETTER_AUTH_SECRET ||= "openapi-generation-stub-secret";

let app: FastifyInstance;
let routeTable: string;
const routeUrls = new Set<string>();

beforeAll(async () => {
  const { registerCoreRoutes } = await import("../index.js");
  app = Fastify({ logger: false, routerOptions: { maxParamLength: 500 } });
  app.addHook("onRoute", (route) => {
    routeUrls.add(route.url);
  });
  await registerCoreRoutes(app, {
    authHandler: async () => new Response(null, { status: 204 }),
    authUiOrigin: "http://localhost:3000",
  });
  await app.ready();
  routeTable = app.printRoutes({ commonPrefix: false });
});

afterAll(async () => {
  await app?.close();
});

describe("registerCoreRoutes", () => {
  it.each([
    "/health",
    "/api/id-schemes",
    "/api/transit/registry",
    "/api/me",
    "/api/capabilities",
    "/api/isochrone",
    "/api/saved/lists",
    "/api/admin/overview",
    "/api/admin/services",
    "/api/data-manager/transit/state",
    "/api/attribution",
  ])("registers %s", (path) => {
    expect(routeTable).toContain(path);
  });

  // A tier entry that names no route is dead weight that hides what the
  // limiter really covers.
  it.each([
    ...TILE_ROUTE_PREFIXES.map((prefix) => ["tile", prefix] as const),
    ...EXPENSIVE_ROUTE_PREFIXES.map((prefix) => ["expensive", prefix] as const),
  ])("gives the %s tier entry %s at least one real route", (_tier, prefix) => {
    const covered = [...routeUrls].filter((url) => url === prefix || url.startsWith(`${prefix}/`));
    expect(covered).not.toEqual([]);
  });

  it("registers the whole core surface, not a subset", () => {
    const operations = routeTable.match(/\((?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)/g) ?? [];
    expect(operations.length).toBeGreaterThanOrEqual(120);
  });
});

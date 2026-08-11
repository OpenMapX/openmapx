import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// `registerCoreRoutes` pulls in Better Auth, which asserts on this at import
// time. The generator sets the same stub for the same reason.
process.env.BETTER_AUTH_SECRET ||= "openapi-generation-stub-secret";

let app: FastifyInstance;
let routeTable: string;

beforeAll(async () => {
  const { registerCoreRoutes } = await import("../index.js");
  app = Fastify({ logger: false, routerOptions: { maxParamLength: 500 } });
  await registerCoreRoutes(app, {
    authHandler: async () => new Response(null, { status: 204 }),
    authUiOrigin: "http://localhost:3000",
  });
  await app.ready();
  routeTable = app.printRoutes({ commonPrefix: false });
});

afterAll(async () => {
  await app.close();
});

describe("registerCoreRoutes", () => {
  it("mounts on a bare Fastify instance with no database, cache or integration host", () => {
    expect(routeTable.length).toBeGreaterThan(0);
  });

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

  it("registers the whole core surface, not a subset", () => {
    const operations = routeTable.match(/\((?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)/g) ?? [];
    expect(operations.length).toBeGreaterThanOrEqual(120);
  });
});

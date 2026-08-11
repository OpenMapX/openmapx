import { describe, expect, it } from "vitest";
import {
  type BuildDocumentInput,
  buildDocument,
  serializeDocument,
  tagForPath,
  toOpenApiPath,
} from "../build-document.js";
import type { IntegrationRouteDescriptor } from "../collect-integration-routes.js";

function integrationRoute(
  overrides: Partial<IntegrationRouteDescriptor> = {},
): IntegrationRouteDescriptor {
  return {
    integrationId: "geocoding",
    method: "GET",
    routePath: "/geocode",
    requireAuth: false,
    sourceFile: "integrations/geocoding/index.ts",
    ...overrides,
  };
}

function input(overrides: Partial<BuildDocumentInput> = {}): BuildDocumentInput {
  return {
    corePaths: {},
    coreAuth: [],
    integrationRoutes: [],
    ...overrides,
  };
}

describe("toOpenApiPath", () => {
  it("rewrites Fastify parameters and wildcards", () => {
    expect(toOpenApiPath("/api/places/:id")).toBe("/api/places/{id}");
    expect(toOpenApiPath("/api/tiles/:z/:x/:y.png")).toBe("/api/tiles/{z}/{x}/{y}.png");
    expect(toOpenApiPath("/api/integrations/:id/*")).toBe("/api/integrations/{id}/{wildcard}");
  });

  it("normalizes the wildcard form @fastify/swagger emits", () => {
    expect(toOpenApiPath("/api/auth/{*}")).toBe("/api/auth/{wildcard}");
  });
});

describe("tagForPath", () => {
  it.each([
    ["/health", "meta"],
    ["/api/id-schemes", "meta"],
    ["/api/admin/overview", "admin"],
    ["/api/data-manager/transit/state", "data-manager"],
    ["/api/auth/*", "auth"],
    ["/auth/oidc/consent", "auth"],
    ["/api/saved/lists", "saved"],
  ])("maps %s to %s", (path, tag) => {
    expect(tagForPath(path)).toBe(tag);
  });
});

describe("buildDocument", () => {
  it("emits an OpenAPI 3.1 document", () => {
    const document = buildDocument(input());
    expect(document.openapi).toBe("3.1.0");
    expect(document.info.title).toBe("OpenMapX API");
  });

  it("mounts integration routes under their integration id", () => {
    const document = buildDocument(input({ integrationRoutes: [integrationRoute()] }));

    expect(Object.keys(document.paths)).toEqual(["/api/integrations/geocoding/geocode"]);
    const operation = document.paths["/api/integrations/geocoding/geocode"]?.get as Record<
      string,
      unknown
    >;
    expect(operation["x-openmapx-auth"]).toBe("public");
    expect(operation["x-openmapx-integration"]).toBe("geocoding");
    expect(operation.tags).toEqual(["integrations"]);
  });

  it("maps a root integration route onto the integration base path", () => {
    const document = buildDocument(
      input({ integrationRoutes: [integrationRoute({ routePath: "/" })] }),
    );
    expect(Object.keys(document.paths)).toEqual(["/api/integrations/geocoding"]);
  });

  it("marks an integration route that requires auth as session-authenticated", () => {
    const document = buildDocument(
      input({ integrationRoutes: [integrationRoute({ requireAuth: true })] }),
    );
    const operation = document.paths["/api/integrations/geocoding/geocode"]?.get as Record<
      string,
      unknown
    >;
    expect(operation["x-openmapx-auth"]).toBe("session");
  });

  it("declares path parameters for templated integration routes", () => {
    const document = buildDocument(
      input({ integrationRoutes: [integrationRoute({ routePath: "/stops/:stopId" })] }),
    );
    const operation = document.paths["/api/integrations/geocoding/stops/{stopId}"]?.get as {
      parameters: { name: string; in: string; required: boolean }[];
    };
    expect(operation.parameters).toEqual([
      { name: "stopId", in: "path", required: true, schema: { type: "string" } },
    ]);
  });

  it("keeps the schemas @fastify/swagger produced for core routes", () => {
    const document = buildDocument(
      input({
        corePaths: {
          "/api/isochrone": {
            get: {
              parameters: [
                { name: "lat", in: "query", required: true, schema: { type: "string" } },
              ],
            },
          },
        },
        coreAuth: [{ method: "GET", url: "/api/isochrone", auth: "public" }],
      }),
    );

    const operation = document.paths["/api/isochrone"]?.get as Record<string, unknown>;
    expect(operation.parameters).toEqual([
      { name: "lat", in: "query", required: true, schema: { type: "string" } },
    ]);
    expect(operation["x-openmapx-auth"]).toBe("public");
  });

  it("never claims an unannotated core route is public", () => {
    const document = buildDocument(input({ corePaths: { "/api/me": { get: {} } }, coreAuth: [] }));
    const operation = document.paths["/api/me"]?.get as Record<string, unknown>;
    expect(operation["x-openmapx-auth"]).toBe("unspecified");
  });

  it("matches a core auth entry whose url still uses Fastify parameter syntax", () => {
    const document = buildDocument(
      input({
        corePaths: { "/api/saved/lists/{id}": { patch: {} } },
        coreAuth: [{ method: "PATCH", url: "/api/saved/lists/:id", auth: "session" }],
      }),
    );
    const operation = document.paths["/api/saved/lists/{id}"]?.patch as Record<string, unknown>;
    expect(operation["x-openmapx-auth"]).toBe("session");
  });

  it("matches core auth entries on method and url together", () => {
    const document = buildDocument(
      input({
        corePaths: { "/api/saved/lists": { get: {}, post: {} } },
        coreAuth: [
          { method: "GET", url: "/api/saved/lists", auth: "session" },
          { method: "POST", url: "/api/saved/lists", auth: "admin" },
        ],
      }),
    );

    const item = document.paths["/api/saved/lists"] as Record<string, Record<string, unknown>>;
    expect(item.get?.["x-openmapx-auth"]).toBe("session");
    expect(item.post?.["x-openmapx-auth"]).toBe("admin");
  });

  it("drops non-HTTP keys from a Fastify path item", () => {
    const document = buildDocument(
      input({ corePaths: { "/api/me": { get: {}, servers: [{ url: "http://x" }] } } }),
    );
    expect(Object.keys(document.paths["/api/me"] ?? {})).toEqual(["get"]);
  });

  it("lists only the tags actually used", () => {
    const document = buildDocument(
      input({
        corePaths: { "/api/admin/overview": { get: {} } },
        integrationRoutes: [integrationRoute()],
      }),
    );
    expect(document.tags.map((tag) => tag.name)).toEqual(["admin", "integrations"]);
  });

  it("produces byte-identical output regardless of input ordering", () => {
    const routes = [
      integrationRoute({ integrationId: "routing", routePath: "/directions" }),
      integrationRoute({ integrationId: "geocoding", routePath: "/geocode" }),
      integrationRoute({ integrationId: "geocoding", method: "POST", routePath: "/geocode" }),
    ];
    const corePathsA = { "/api/me": { get: {} }, "/api/admin/overview": { get: {} } };
    const corePathsB = { "/api/admin/overview": { get: {} }, "/api/me": { get: {} } };

    const first = serializeDocument(
      buildDocument(input({ corePaths: corePathsA, integrationRoutes: routes })),
    );
    const second = serializeDocument(
      buildDocument(input({ corePaths: corePathsB, integrationRoutes: [...routes].reverse() })),
    );

    expect(first).toBe(second);
  });

  it("sorts paths and methods deterministically", () => {
    const document = buildDocument(
      input({
        corePaths: {
          "/api/zebra": { post: {}, get: {}, delete: {} },
          "/api/alpha": { get: {} },
        },
      }),
    );

    expect(Object.keys(document.paths)).toEqual(["/api/alpha", "/api/zebra"]);
    expect(Object.keys(document.paths["/api/zebra"] ?? {})).toEqual(["get", "post", "delete"]);
  });
});

describe("serializeDocument", () => {
  it("writes 2-space JSON with a trailing newline", () => {
    const text = serializeDocument(buildDocument(input()));
    expect(text.endsWith("}\n")).toBe(true);
    expect(text).toContain('\n  "openapi": "3.1.0"');
  });
});

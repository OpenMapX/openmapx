import { setup } from "@integrations/routing";
import {
  API_ENDPOINTS,
  ApiClient,
  type LngLat,
  type ScheduledDirectionsResult,
} from "@openmapx/core";
import type { LoadedIntegration, RoutingProvider } from "@openmapx/integration-framework";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { licensingFromDeclaration } from "@openmapx/mobility-core/licensing";
import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import {
  registerIntegrationRoute,
  registerIntegrationRouteDispatcher,
  resetIntegrationRoutes,
} from "../../integration-routes";

vi.mock("../../utils/require-auth.js", () => ({
  requireAuth: vi.fn().mockRejectedValue(new Error("Unexpected authenticated call")),
}));

it("preserves composed geometry receipts and native empty spans through scheduled HTTP and the core client", async () => {
  const first = {
    sourceId: "shared-feed",
    name: "Supplier",
    url: "https://supplier.test/data",
    licensing: {
      version: 1,
      bindings: [
        {
          scope: "data",
          subject: "Data",
          license: { kind: "spdx", expression: "CC-BY-4.0", url: "https://supplier.test/license" },
        },
      ],
    } as const,
    attributionText: "First acquisition required notice",
    publisher: { name: "Publisher", url: "https://publisher.test" },
  };
  const last = { ...first, attributionText: "Last acquisition required notice" };
  const waypoints: LngLat[] = [
    [6.96, 50.94],
    [7.1, 50.73],
    [6.08, 50.77],
    [6.96, 50.94],
  ];
  const provider: RoutingProvider = {
    id: "native",
    supportedModes: ["driving"],
    supportsTimeAware: true,
    async getRoute(points) {
      const contributors = points[0][0] === 6.96 ? [first] : points[0][0] === 7.1 ? [] : [last];
      return {
        waypoints: points,
        activeRouteIndex: 0,
        routes: [
          {
            geometry: points,
            distance: 1000,
            duration: 60,
            mode: "driving",
            steps: [],
            legs: [{ geometry: points, distance: 1000, duration: 60, steps: [], contributors }],
            contributors,
          },
        ],
      };
    },
  };
  const ctx = createMockIntegrationContext({ id: "routing" });
  const loaded: LoadedIntegration = {
    id: "routing-native",
    enabled: true,
    isBuiltIn: true,
    directory: "integrations/routing-native",
    config: {},
    strings: {},
    shutdownHandlers: [],
    manifest: {
      id: "routing-native",
      domains: ["routing"],
      dataSources: [
        {
          sourceId: "catalogue-only",
          name: "Unused catalogue",
          url: "https://unused.test",
          licensing: licensingFromDeclaration("CC0", undefined, "Unused catalogue"),
          providerCountry: "DE",
          providerPrivacyUrl: "https://unused.test/privacy",
        },
      ],
    },
    providers: new Map([["routing", [provider]]]),
  };
  ctx.getIntegrationsByDomain = (domain) => (domain === "routing" ? [loaded] : []);
  ctx.registerRoute = (method, path, handler, options) =>
    registerIntegrationRoute("routing", method, path, handler, options);
  const app = Fastify();
  resetIntegrationRoutes();
  setup(ctx);
  registerIntegrationRouteDispatcher(app, new Map([["routing", { ...loaded, id: "routing" }]]));
  // Replace only the network transport. Real client encoding/JSON parsing and
  // the registered handler, schedule composition and Fastify serializer run.
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const url = new URL(input);
    const response = await app.inject({
      method: init?.method as "POST",
      url: `${url.pathname}${url.search}`,
      headers: Object.fromEntries(new Headers(init?.headers)),
      payload: init?.body as string,
    });
    expect(response.statusCode, response.body).toBe(200);
    return new Response(response.body, {
      status: response.statusCode,
      headers: { "Content-Type": String(response.headers["content-type"]) },
    });
  });
  try {
    const client = new ApiClient({ baseUrl: "https://api.test", credentials: "omit" });
    const parsed = await client.post<ScheduledDirectionsResult>(API_ENDPOINTS.directionsSchedule, {
      waypoints,
      departAt: "2027-09-01T09:00",
    });
    expect(parsed.routes).toHaveLength(1);
    expect(parsed.routes[0].geometry).toEqual(waypoints);
    expect(parsed.routes[0].geometryContributors).toEqual([
      { startIndex: 0, endIndex: 1, contributors: [first] },
      { startIndex: 1, endIndex: 2, contributors: [] },
      { startIndex: 2, endIndex: 3, contributors: [last] },
    ]);
    expect(parsed.routes[0].contributors).toEqual([first, last]);
    expect(parsed.routes[0].legs.map((leg) => leg.contributors)).toEqual([[first], [], [last]]);
    first.attributionText = "Changed after delivery";
    first.publisher.name = "Changed publisher";
    const captured = parsed.routes[0].geometryContributors?.[0].contributors?.[0];
    expect(captured).toBeDefined();
    if (!captured) throw new Error("Expected the first captured geometry receipt");
    expect(captured).toMatchObject({
      attributionText: "First acquisition required notice",
      publisher: { name: "Publisher" },
    });
  } finally {
    vi.unstubAllGlobals();
    await app.close();
    resetIntegrationRoutes();
  }
});

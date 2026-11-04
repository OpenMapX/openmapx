import { featureCollectionToRoadFlowSegments } from "@integrations/openconditions/road-conditions/flow";
import { setup } from "@integrations/road-conditions/index";
import type { IntegrationContext } from "@openmapx/integration-framework";
import Fastify, { type HTTPMethods, type RouteHandlerMethod } from "fastify";
import { expect, it } from "vitest";

it("preserves selected OC field receipts through real GeoJSON and projected-route HTTP serialization", async () => {
  const receipt = {
    sourceId: "measurement-a",
    name: "Captured publisher",
    attributionText: "Original mandatory notice",
    publisher: { name: "Original parent" },
  };
  const fields = { geometry: [], ratio: [receipt], los: [], confidence: [receipt] };
  const geometry: [[number, number], [number, number]] = [
    [6, 51],
    [6.01, 51],
  ];
  const segments = featureCollectionToRoadFlowSegments(
    {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "LineString", coordinates: geometry },
          properties: {
            segment_id: "s1",
            speed_ratio: 0.4,
            los: "queuing",
            confidence: "measured",
            direction: "forward",
            field_contributors: JSON.stringify(fields),
          },
        },
      ],
    },
    "openconditions",
  );
  receipt.name = "Changed catalogue";
  receipt.attributionText = "Changed notice";
  // A segment's rated values are derived, and the notice survives serialization.
  const captured = {
    ...receipt,
    name: "Captured publisher",
    attributionText: "Original mandatory notice",
    modified: true,
  };
  const app = Fastify();
  const provider = {
    id: "openconditions",
    getEvents: async () => [],
    getFlow: async () => segments,
  };
  setup({
    registerRoute: (
      method: string,
      path: string,
      handler: Parameters<IntegrationContext["registerRoute"]>[2],
    ) =>
      app.route({
        method: method as HTTPMethods,
        url: path,
        handler: handler as unknown as RouteHandlerMethod,
      }),
    cache: {
      del: async () => {},
      withCache: async (_key: string, _ttl: number, load: () => Promise<unknown>) => load(),
    },
    getIntegrationsByDomain: () => [{ providers: new Map([["road-conditions", [provider]]]) }],
    log: { info() {}, warn() {}, error() {}, debug() {} },
  } as unknown as IntegrationContext);
  try {
    const response = await app.inject({ method: "GET", url: "/flow?bbox=5,50,7,52" });
    expect(response.statusCode).toBe(200);
    expect(response.json().features[0].properties.fieldContributors).toEqual({
      ...fields,
      ratio: [captured],
      confidence: [captured],
    });
    const route = await app.inject({
      method: "POST",
      url: "/flow-along-route",
      payload: { routes: [{ id: "selected", geometry }] },
    });
    expect(route.statusCode).toBe(200);
    expect(route.json().routes[0].spans.length).toBeGreaterThan(0);
    expect(route.json().routes[0].spans[0].fieldContributors).toEqual({
      ...fields,
      ratio: [captured],
      confidence: [captured],
    });
  } finally {
    await app.close();
  }
});

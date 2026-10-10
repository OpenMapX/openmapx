import { setup as setupDataSource } from "@integrations/data-source";
import type {
  IntegrationContext,
  LoadedIntegration,
  MobilityDataSourceProvider,
} from "@openmapx/integration-framework";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../utils/require-auth.js", () => ({
  requireAuth: vi.fn().mockRejectedValue(new Error("requireAuth should not be called")),
}));

import {
  registerIntegrationRoute,
  registerIntegrationRouteDispatcher,
  resetIntegrationRoutes,
} from "../../integration-routes.js";
import { buildTestApp } from "../../test/app.js";

const FRESHNESS = { fetchedAt: "2026-10-05T10:00:00.000Z", hasRealtimeData: false, isStale: false };

/** The item ids the detail route was asked for, as the provider received them. */
const asked: string[] = [];

const provider = {
  id: "parking",
  meta: { minZoom: 8, showResultsList: true, markerStyle: { type: "icon" } },
  attribution: [],
  getFilters: async () => [],
  search: async () => ({ data: [], attributions: [], freshness: FRESHNESS }),
  getDetail: async (id: string) => {
    asked.push(id);
    return {
      data: { id, name: "P", coordinates: [3.68, 51.02], source: "oc", sections: [] },
      attributions: [],
      freshness: FRESHNESS,
    };
  },
} as unknown as MobilityDataSourceProvider;

async function plugin(fastify: FastifyInstance): Promise<void> {
  const ctx = createMockIntegrationContext({ id: "data-source" });
  const parking = {
    manifest: { id: "parking", frontend: { searchCategory: { label: "Parking" } } },
    providers: new Map([["data-source", [provider]]]),
  };
  Object.assign(ctx, {
    getIntegrationsByDomain: ((domain: string) =>
      domain === "data-source" ? [parking] : []) as IntegrationContext["getIntegrationsByDomain"],
    registerRoute: (
      method: string,
      path: string,
      handler: Parameters<typeof registerIntegrationRoute>[3],
      options?: Parameters<typeof registerIntegrationRoute>[4],
    ) => registerIntegrationRoute("data-source", method, path, handler, options),
  });
  setupDataSource(ctx);
  const loaded = { id: "data-source", enabled: true } as LoadedIntegration;
  registerIntegrationRouteDispatcher(fastify, new Map([["data-source", loaded]]));
}

describe("data-source detail over the production dispatcher", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    asked.length = 0;
    resetIntegrationRoutes();
    app = await buildTestApp(plugin as FastifyPluginAsync);
  });

  afterEach(async () => {
    await app.close();
    resetIntegrationRoutes();
  });

  it.each([
    "oc:feature:osm-parking:way/123",
    "oc:feature:be-vlg-gent-parking:https://stad.gent/nl/loop/mobiliteit-loop#Parkeerterreinen_Stad_Gent",
    "oc:feature:x:a%20b",
  ])("an encoded item id reaches the provider as it was: %s", async (id) => {
    const response = await app.inject({
      method: "GET",
      url: `/api/integrations/data-source/parking/detail/${encodeURIComponent(id)}`,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(asked).toEqual([id]);
    expect(response.json().data.id).toBe(id);
  });
});

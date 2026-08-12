import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setup as setupSearchSuggestions } from "@integrations/search-suggestions";
import type {
  IntegrationManifest,
  LoadedIntegration,
  SearchSuggestionProvider,
} from "@openmapx/integration-framework";
import { validateManifest } from "@openmapx/integration-framework";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../redis.js", () => ({ redis: null }));
vi.mock("../../utils/require-auth.js", () => ({
  requireAuth: vi.fn().mockRejectedValue(new Error("requireAuth should not be called")),
}));

import { createCacheClient } from "../../integration-clients.js";
import {
  registerIntegrationRoute,
  registerIntegrationRouteDispatcher,
  resetIntegrationRoutes,
} from "../../integration-routes.js";
import { buildTestApp } from "../../test/app.js";

const SEARCH_DIR = join(
  fileURLToPath(import.meta.url),
  "../../../../../../integrations/search-suggestions",
);

function loadManifest(): IntegrationManifest {
  const raw = JSON.parse(readFileSync(join(SEARCH_DIR, "manifest.json"), "utf-8"));
  const validation = validateManifest(raw);
  if (!validation.valid) throw new Error(validation.errors.join(", "));
  return raw as IntegrationManifest;
}

function loaded(
  id: string,
  manifest: IntegrationManifest,
  provider?: SearchSuggestionProvider,
): LoadedIntegration {
  return {
    id,
    manifest,
    config: {},
    directory: SEARCH_DIR,
    isBuiltIn: true,
    enabled: true,
    providers: new Map(provider ? [["search-suggestions", [provider]]] : []),
    strings: {},
    shutdownHandlers: [],
  };
}

const fixtureProvider: SearchSuggestionProvider = {
  id: "fixture-catalog",
  async searchSuggestions(query) {
    const matches = {
      FRA: ["oa:EDDF", "Frankfurt Airport", "authoritative_code", "FRA"],
      EDDF: ["oa:EDDF", "Frankfurt Airport", "authoritative_code", "EDDF"],
      MIT: ["osm:relation/1", "Massachusetts Institute of Technology", "explicit_alias", "MIT"],
      UNCC: [
        "osm:relation/2",
        "University of North Carolina at Charlotte",
        "generated_acronym",
        "UNCC",
      ],
      "8000207": ["db:8000207", "Hamburg Hbf", "authoritative_code", "8000207"],
    } as const;
    const match = matches[query.query as keyof typeof matches];
    if (!match) return { suggestions: [], attributions: [], freshnessSeconds: 300 };
    return {
      suggestions: [
        {
          id: match[0],
          label: match[1],
          coordinates: [8, 50],
          type: match[0].startsWith("db:") ? "transit_stop" : "poi",
          searchMatch: {
            kind: match[2],
            value: match[3],
            normalized: match[3].toLowerCase(),
          },
          importance: 0.8,
          provider: "fixture-catalog",
        },
      ],
      attributions: [{ sourceId: "fixture", name: "Fixture catalog" }],
      freshnessSeconds: 300,
    };
  },
};

async function plugin(fastify: FastifyInstance): Promise<void> {
  const manifest = loadManifest();
  const orchestratorIntegration = loaded("search-suggestions", manifest);
  const fixtureIntegration = loaded("fixture-catalog", manifest, fixtureProvider);
  const integrations = new Map([
    [orchestratorIntegration.id, orchestratorIntegration],
    [fixtureIntegration.id, fixtureIntegration],
  ]);
  const ctx = createMockIntegrationContext({
    id: "search-suggestions",
    manifest,
    cache: createCacheClient("search-suggestions-test"),
  });
  ctx.getIntegrationsByDomain = () => [fixtureIntegration];
  ctx.registerRoute = (method, path, handler, options) => {
    registerIntegrationRoute("search-suggestions", method, path, handler, options);
  };
  setupSearchSuggestions(ctx);
  registerIntegrationRouteDispatcher(fastify, integrations);
}

describe("search suggestions over Fastify injection", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    resetIntegrationRoutes();
    app = await buildTestApp(plugin as FastifyPluginAsync);
  });

  afterEach(async () => {
    await app.close();
    resetIntegrationRoutes();
  });

  for (const [query, expectedKind] of [
    ["FRA", "authoritative_code"],
    ["EDDF", "authoritative_code"],
    ["MIT", "explicit_alias"],
    ["UNCC", "generated_acronym"],
    ["8000207", "authoritative_code"],
  ] as const) {
    it(`${query} returns normalized ${expectedKind} evidence`, async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/integrations/search-suggestions/search?q=${query}&lang=en`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        suggestions: [{ searchMatch: { kind: expectedKind } }],
        partial: false,
      });
    });
  }

  it("returns an empty successful response when no provider has a match", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/integrations/search-suggestions/search?q=ZZZZZZ&lang=en",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ suggestions: [], attributions: [], partial: false });
  });
});

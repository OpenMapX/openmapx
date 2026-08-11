/**
 * Regression guard for the four brand routes over real HTTP semantics — the
 * gap the earlier handler-level tests (`integrations/poi-search/__tests__/brand-routes.test.ts`)
 * leave open. Those drive the route handlers directly with a hand-built
 * `ctx`/`reply` fake whose cache stub calls `fn()` straight through, so they
 * never touch Fastify's query-string parsing, `:qid` path routing, JSON
 * serialization, or a real cache client. This file wires the real
 * `integrations/poi-search` `setup()` onto a real Fastify instance through the
 * production `registerIntegrationRoute` / `registerIntegrationRouteDispatcher`
 * plumbing (`apps/api/src/integration-routes.ts`) and exercises it with
 * `app.inject()` — no Docker, no Postgres, no network.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setup as setupPoiSearch } from "@integrations/poi-search";
import type { IntegrationManifest, LoadedIntegration } from "@openmapx/integration-framework";
import { validateManifest } from "@openmapx/integration-framework";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The route handlers reach `ctx.cache.withCache`; mocking redis out (rather
// than stubbing the cache client ourselves) lets the test use the real
// `createCacheClient` from `../../integration-clients.js` in its legitimate
// no-Redis fallback branch, matching this environment (Docker/Redis
// unavailable) instead of reinventing a passthrough fake.
vi.mock("../../redis.js", () => ({ redis: null }));

// `integration-routes.ts` pulls in `requireAuth`, which needs `BETTER_AUTH_SECRET`
// at import time. None of the brand routes are `requireAuth: true`, so a stub
// that always throws (never called) sidesteps the env requirement without
// weakening what this file actually exercises.
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

// This file lives at apps/api/src/routes/__tests__/; six levels up is the
// repo root (…/__tests__ -> routes -> src -> api -> apps -> repo root).
const POI_SEARCH_DIR = join(
  fileURLToPath(import.meta.url),
  "../../../../../../integrations/poi-search",
);

function loadPoiSearchManifest(): IntegrationManifest {
  const raw = JSON.parse(readFileSync(join(POI_SEARCH_DIR, "manifest.json"), "utf-8"));
  const validation = validateManifest(raw);
  if (!validation.valid) {
    throw new Error(`poi-search manifest failed validation: ${validation.errors.join(", ")}`);
  }
  return raw as IntegrationManifest;
}

async function poiSearchPlugin(fastify: FastifyInstance): Promise<void> {
  const manifest = loadPoiSearchManifest();

  const integration: LoadedIntegration = {
    id: "poi-search",
    manifest,
    config: {},
    directory: POI_SEARCH_DIR,
    isBuiltIn: true,
    enabled: true,
    providers: new Map(),
    strings: {},
    shutdownHandlers: [],
  };
  const integrations = new Map<string, LoadedIntegration>([["poi-search", integration]]);

  const ctx = createMockIntegrationContext({
    id: "poi-search",
    manifest,
    cache: createCacheClient("poi-search"),
  });
  // Route through the same registration path production uses instead of the
  // testing helper's default (which only captures registrations for
  // inspection) so routes actually dispatch through Fastify.
  ctx.registerRoute = (method, path, handler, options) => {
    registerIntegrationRoute("poi-search", method, path, handler, options);
  };

  await setupPoiSearch(ctx);
  registerIntegrationRouteDispatcher(fastify, integrations);
}

describe("poi-search brand routes over real HTTP (Fastify inject)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    resetIntegrationRoutes();
    app = await buildTestApp(poiSearchPlugin as FastifyPluginAsync);
  });

  afterEach(async () => {
    await app.close();
    resetIntegrationRoutes();
  });

  it("GET /brand-suggest?q=aldi&country=de&limit=5 -> 200 with non-empty matches", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/integrations/poi-search/brand-suggest?q=aldi&country=de&limit=5",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { matches: Array<{ qid: string; name: string }> };
    expect(body.matches.length).toBeGreaterThan(0);
  });

  it("GET /brand-suggest?q=a -> 200 with matches === [] (below the route's query floor)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/integrations/poi-search/brand-suggest?q=a",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ matches: [] });
  });

  it("GET /brand-suggest?q=aldi&limit=999 -> 200 with matches clamped to 20", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/integrations/poi-search/brand-suggest?q=aldi&limit=999",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { matches: unknown[] };
    expect(body.matches.length).toBeLessThanOrEqual(20);
  });

  it("GET /brand/Q37158 -> 200 with body.qid === 'Q37158' (Starbucks)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/integrations/poi-search/brand/Q37158",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { qid: string; name: string };
    expect(body.qid).toBe("Q37158");
    expect(body.name.toLowerCase()).toContain("starbucks");
  });

  it("GET /brand/Q00000000 -> 404 for a well-formed but unknown QID", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/integrations/poi-search/brand/Q00000000",
    });

    expect(res.statusCode).toBe(404);
  });

  it("GET /brand/banana -> 400 for a malformed QID", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/integrations/poi-search/brand/banana",
    });

    expect(res.statusCode).toBe(400);
  });
});
